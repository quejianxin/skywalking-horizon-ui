/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import type { ConfigSource } from '../../config/loader.js';
import { configSchema } from '../../config/schema.js';
import { logger } from '../../logger.js';
import { LogSourceStore } from '../../logs/sources.js';
import { logSourceInputSchema } from '../../logs/sources.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { SessionStore } from '../../user/sessions.js';
import { registerLogSearchRoutes } from './log-search.js';

const SEARCH_URL = '/api/logs/search';
const LINK_URL = '/api/logs/trace-link';
const SOURCES_URL = '/api/logs/sources';
const ES_URL = 'http://es.example.test:9200';
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

const directories: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

interface FakeEsOptions {
  hits?: Array<{ id: string; traceId?: string }>;
  total?: number;
  status?: number;
}

/** 同时应答 ES 与 OAP GraphQL 的假 fetch，按 URL 分流。 */
function fakeFetch(es: FakeEsOptions = {}): FetchLike {
  return async (input) => {
    const url = String(input);
    if (url.includes('/graphql')) {
      return json({ data: { trace: { spans: [] } } });
    }
    if (es.status && es.status >= 400) {
      return json({ error: { reason: 'index_not_found_exception' } }, es.status);
    }
    const hits = (es.hits ?? []).map((hit) => ({
      _id: hit.id,
      _source: { '@timestamp': NOW - 1_000, message: 'boom', ...(hit.traceId ? { traceId: hit.traceId } : {}) },
    }));
    return json({ took: 3, timed_out: false, hits: { total: es.total ?? hits.length, hits } });
  };
}

async function buildApp(fetch: FetchLike) {
  const directory = mkdtempSync(join(tmpdir(), 'horizon-log-search-route-'));
  directories.push(directory);
  const cfg = configSchema.parse({
    rbac: {
      roles: {
        logReader: ['logs:read'],
        traceReader: ['traces:read'],
        logAndTraceReader: ['logs:read', 'traces:read'],
        layerTraceReader: ['logs:read', 'traces:read@GENERAL'],
        layerLogReader: ['traces:read', 'logs:read@GENERAL'],
        sourceAdmin: ['log-source:read', 'log-source:write'],
      },
    },
  });
  const config: ConfigSource = {
    current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {},
  };
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const store = new LogSourceStore({ filePath: join(directory, 'log-sources.json'), allowedBaseUrls: new Set([ES_URL]) });
  const source = store.create(logSourceInputSchema.parse({
    name: 'prod-es',
    url: ES_URL,
    index: 'app-logs-*',
  }));
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  registerLogSearchRoutes(app, { config, sessions, store, fetch });
  await app.ready();
  return { app, sessions, source };
}

function sessionCookie(sessions: SessionStore, role: string) {
  return { cookie: `horizon_sid=${sessions.create('test-user', [role]).sid}` };
}

const UNKNOWN_SOURCE = '7d1f4b0e-0000-4000-8000-000000000000';

describe('日志检索接口', () => {
  it('拒绝未认证与无 logs:read 的调用', async () => {
    const { app, sessions, source } = await buildApp(fakeFetch());
    const anonymous = await app.inject({ method: 'POST', url: SEARCH_URL, payload: { sourceId: source.id } });
    expect(anonymous.statusCode).toBe(401);
    const denied = await app.inject({
      method: 'POST',
      url: SEARCH_URL,
      headers: sessionCookie(sessions, 'sourceAdmin'),
      payload: { sourceId: source.id },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'permission_denied', verb: 'logs:read' });
  });

  it('参数不合法指出字段，未知数据源返回 404', async () => {
    const { app, sessions, source } = await buildApp(fakeFetch());
    const headers = sessionCookie(sessions, 'logReader');
    const bad = await app.inject({ method: 'POST', url: SEARCH_URL, headers, payload: { sourceId: 'nope' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'BAD_LOG_QUERY' });
    expect(bad.json().details).toEqual([{ path: 'sourceId', message: expect.any(String) }]);

    const unknown = await app.inject({ method: 'POST', url: SEARCH_URL, headers, payload: { sourceId: UNKNOWN_SOURCE } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'LOG_SOURCE_NOT_FOUND' });

    const extra = await app.inject({
      method: 'POST', url: SEARCH_URL, headers, payload: { sourceId: source.id, index: 'other-*' },
    });
    expect(extra.statusCode).toBe(400);
  });

  it('查询语法错误返回 400 与出错位置，时间范围错误同样归为 400', async () => {
    const { app, sessions, source } = await buildApp(fakeFetch());
    const headers = sessionCookie(sessions, 'logReader');
    const syntax = await app.inject({
      method: 'POST', url: SEARCH_URL, headers, payload: { sourceId: source.id, query: 'message:"abc' },
    });
    expect(syntax.statusCode).toBe(400);
    expect(syntax.json()).toMatchObject({ code: 'BAD_LOG_QUERY', position: 8 });
    expect(syntax.json().message).toContain('引号未闭合');

    const range = await app.inject({
      method: 'POST',
      url: SEARCH_URL,
      headers,
      payload: { sourceId: source.id, startMs: NOW, endMs: NOW - 1 },
    });
    expect(range.statusCode).toBe(400);
    expect(range.json().message).toContain('开始时间不能晚于结束时间');
  });

  it('检索成功返回行与总数，审计日志不记录查询语句', async () => {
    const info = vi.spyOn(logger, 'info');
    const { app, sessions, source } = await buildApp(fakeFetch({ hits: [{ id: 'a', traceId: 'trace-a' }, { id: 'b' }], total: 40 }));
    const headers = sessionCookie(sessions, 'logReader');
    const reply = await app.inject({
      method: 'POST', url: SEARCH_URL, headers, payload: { sourceId: source.id, query: 'level:ERROR' },
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ reachable: true, total: 40, hasNext: false, truncated: false, tookMs: 3 });
    expect(reply.json().logs).toHaveLength(2);
    expect(reply.json().logs[0]).toMatchObject({ id: 'a', message: 'boom', traceId: 'trace-a' });

    const line = info.mock.calls.map(([message]) => String(message)).find((text) => text.includes('日志检索'))!;
    expect(line).toContain('user=test-user');
    expect(line).toContain(`source=${source.id}`);
    expect(line).toContain('rows=2');
    expect(line).toContain('total=40');
    expect(line).not.toContain('level:ERROR');
  });

  it('ES 不可达时以 200 返回 reachable=false，不影响页面其余部分', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const { app, sessions, source } = await buildApp(fetch);
    const reply = await app.inject({
      method: 'POST', url: SEARCH_URL, headers: sessionCookie(sessions, 'logReader'), payload: { sourceId: source.id },
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ reachable: false, logs: [] });
    expect(reply.json().error).toContain('不可达');
  });

  it('ES 4xx 也作为数据源故障返回，而不是 500', async () => {
    const { app, sessions, source } = await buildApp(fakeFetch({ status: 404 }));
    const reply = await app.inject({
      method: 'POST', url: SEARCH_URL, headers: sessionCookie(sessions, 'logReader'), payload: { sourceId: source.id },
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json().reachable).toBe(false);
    expect(reply.json().error).toContain('HTTP 404');
    expect(reply.body).not.toContain('index_not_found_exception');
  });
});

describe('日志检索数据源列表', () => {
  it('只给 logs:read 的账号也能拿到数据源，但只有 id、名称与索引', async () => {
    const { app, sessions, source } = await buildApp(fakeFetch());
    const reply = await app.inject({ method: 'GET', url: SOURCES_URL, headers: sessionCookie(sessions, 'logReader') });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ sources: [{ id: source.id, name: 'prod-es', index: 'app-logs-*' }] });
  });

  it('未认证或没有 logs:read 时拒绝', async () => {
    const { app, sessions } = await buildApp(fakeFetch());
    const anonymous = await app.inject({ method: 'GET', url: SOURCES_URL });
    expect(anonymous.statusCode).toBe(401);
    const denied = await app.inject({ method: 'GET', url: SOURCES_URL, headers: sessionCookie(sessions, 'sourceAdmin') });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: 'permission_denied', verb: 'logs:read' });
  });
});

describe('日志串联链路接口', () => {
  it('没有 traceId 时不发送任何上游请求', async () => {
    const fetch = vi.fn(fakeFetch());
    const { app, sessions } = await buildApp(fetch);
    const reply = await app.inject({
      method: 'POST', url: LINK_URL, headers: sessionCookie(sessions, 'logAndTraceReader'), payload: { rowTraceIds: [null] },
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ linkedCount: 0, unlinkedCount: 1, traces: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('只向 OAP 查询提交的 Trace ID，重复行只查一次', async () => {
    const fetch = vi.fn<FetchLike>(async () => json({ data: { trace: { spans: [{
      serviceCode: 'order', startTime: 1_000, endTime: 1_400,
      endpointName: 'GET:/order', type: 'Exit', peer: 'mysql://db:3306', component: 'MYSQL',
      isError: true, layer: 'DATABASE',
    }] } } }));
    const { app, sessions } = await buildApp(fetch);
    const reply = await app.inject({
      method: 'POST', url: LINK_URL, headers: sessionCookie(sessions, 'logAndTraceReader'),
      payload: { rowTraceIds: ['trace-a', 'trace-a', null] },
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ linkedCount: 2, unlinkedCount: 1 });
    expect(reply.json().traces).toEqual([{
      traceId: 'trace-a', startMs: 1_000, durationMs: 400, isError: true, services: ['order'], spanCount: 1,
    }]);
    expect(reply.json().entities.db).toEqual([{
      kind: 'db', name: 'MYSQL', component: 'MYSQL', peer: 'mysql://db:3306', spanCount: 1, traceIds: ['trace-a'],
    }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/graphql$/);
    expect(JSON.parse(String(init?.body)).variables).toEqual({ traceId: 'trace-a' });
  });

  it.each(['logReader', 'traceReader', 'layerTraceReader', 'layerLogReader'])('拒绝权限不足的 %s', async (role) => {
    const fetch = vi.fn(fakeFetch());
    const { app, sessions } = await buildApp(fetch);
    const reply = await app.inject({
      method: 'POST', url: LINK_URL, headers: sessionCookie(sessions, role), payload: { rowTraceIds: ['trace-a'] },
    });
    expect(reply.statusCode).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('拒绝非法 Trace ID 以及多余的请求字段', async () => {
    const fetch = vi.fn(fakeFetch());
    const { app, sessions, source } = await buildApp(fetch);
    const headers = sessionCookie(sessions, 'logAndTraceReader');
    for (const payload of [{ rowTraceIds: [' trace-a'] }, { rowTraceIds: [], sourceId: source.id }]) {
      expect((await app.inject({ method: 'POST', url: LINK_URL, headers, payload })).statusCode).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
