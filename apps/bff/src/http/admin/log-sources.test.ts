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
import type { ConfigSource } from '../../config/loader.js';
import { configSchema } from '../../config/schema.js';
import { LogSourceStore } from '../../logs/sources.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { SessionStore } from '../../user/sessions.js';
import { registerLogSourcesAdminRoutes } from './log-sources.js';

const URL = '/api/admin/log-sources';
/** 只用于权限检查之前就被拒绝的请求，不对应任何已存数据源。 */
const PLACEHOLDER_ID = 'b0f0f0f0-0000-4000-8000-0000000000ff';
const FAKE_CREDENTIAL = 'invented-test-credential';
const input = {
  name: 'prod-es',
  url: 'https://es.example.test:9200',
  index: 'app-logs-*',
  auth: 'basic' as const,
  username: 'reader',
  credential: FAKE_CREDENTIAL,
};

const apps: FastifyInstance[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function buildApp(writable = true) {
  const directory = mkdtempSync(join(tmpdir(), 'horizon-log-sources-route-'));
  directories.push(directory);
  const filePath = writable ? join(directory, 'log-sources.json') : '';
  const cfg = configSchema.parse({
    rbac: {
      roles: {
        reader: ['log-source:read'],
        writer: ['log-source:read', 'log-source:write'],
      },
    },
  });
  const config: ConfigSource = {
    current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {},
  };
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const store = new LogSourceStore({ filePath, allowedBaseUrls: new Set([input.url]) });
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  registerLogSourcesAdminRoutes(app, { config, sessions, store });
  await app.ready();
  return { app, sessions, store };
}

function sessionCookie(sessions: SessionStore, role: string) {
  return { cookie: `horizon_sid=${sessions.create('test-user', [role]).sid}` };
}

describe('日志数据源管理接口', () => {
  it('拒绝未认证的读取与写入', async () => {
    const { app } = await buildApp();
    const get = await app.inject({ method: 'GET', url: URL });
    const post = await app.inject({ method: 'POST', url: URL, payload: input });
    expect(get.statusCode).toBe(401);
    expect(post.statusCode).toBe(401);
    expect(post.json()).toEqual({ error: 'unauthenticated' });
  });

  it('只读权限可列表但不能增删改或连接测试', async () => {
    const { app, sessions } = await buildApp();
    const headers = sessionCookie(sessions, 'reader');
    const get = await app.inject({ method: 'GET', url: URL, headers });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ writable: true, sources: [] });

    const post = await app.inject({ method: 'POST', url: URL, headers, payload: input });
    const put = await app.inject({ method: 'PUT', url: `${URL}/${PLACEHOLDER_ID}`, headers, payload: input });
    const remove = await app.inject({ method: 'DELETE', url: `${URL}/${PLACEHOLDER_ID}`, headers });
    const test = await app.inject({ method: 'POST', url: `${URL}/${PLACEHOLDER_ID}/test`, headers });
    for (const reply of [post, put, remove, test]) {
      expect(reply.statusCode).toBe(403);
      expect(reply.json()).toEqual({ error: 'permission_denied', verb: 'log-source:write' });
    }
  });

  it('写权限创建后列表可见，响应不回显凭据', async () => {
    const { app, sessions } = await buildApp();
    const headers = sessionCookie(sessions, 'writer');
    const post = await app.inject({ method: 'POST', url: URL, headers, payload: input });
    expect(post.statusCode).toBe(201);
    const created = post.json();
    expect(created).toMatchObject({ name: input.name, url: input.url, index: input.index, hasCredential: true });
    expect(created).not.toHaveProperty('credential');
    expect(post.body).not.toContain(FAKE_CREDENTIAL);

    const list = await app.inject({ method: 'GET', url: URL, headers });
    expect(list.json().sources).toEqual([created]);
    expect(list.body).not.toContain(FAKE_CREDENTIAL);

    const remove = await app.inject({ method: 'DELETE', url: `${URL}/${created.id}`, headers });
    expect(remove.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: URL, headers });
    expect(after.json().sources).toEqual([]);
  });

  it('字段不合法时返回 400 并指出字段', async () => {
    const { app, sessions } = await buildApp();
    const headers = sessionCookie(sessions, 'writer');
    const post = await app.inject({ method: 'POST', url: URL, headers, payload: { ...input, url: 'ftp://es.example.test', auth: 'none' } });
    expect(post.statusCode).toBe(400);
    expect(post.json()).toMatchObject({ code: 'BAD_LOG_SOURCE' });
    expect(post.json().details).toEqual([{ path: 'url', message: expect.any(String) }]);
  });

  it('未知 id 返回 404，非法 id 返回 400', async () => {
    const { app, sessions } = await buildApp();
    const headers = sessionCookie(sessions, 'writer');
    const unknown = '7d1f4b0e-0000-4000-8000-000000000000';
    const put = await app.inject({ method: 'PUT', url: `${URL}/${unknown}`, headers, payload: input });
    const remove = await app.inject({ method: 'DELETE', url: `${URL}/${unknown}`, headers });
    expect(put.statusCode).toBe(404);
    expect(put.json()).toMatchObject({ code: 'LOG_SOURCE_NOT_FOUND' });
    expect(remove.statusCode).toBe(404);

    const badId = await app.inject({ method: 'DELETE', url: `${URL}/not-a-uuid`, headers });
    expect(badId.statusCode).toBe(400);
    expect(badId.json()).toMatchObject({ code: 'BAD_LOG_SOURCE' });
  });

  it('未配置文件时为只读，写入返回 409', async () => {
    const { app, sessions } = await buildApp(false);
    const headers = sessionCookie(sessions, 'writer');
    const get = await app.inject({ method: 'GET', url: URL, headers });
    expect(get.json()).toEqual({ writable: false, sources: [] });
    const post = await app.inject({ method: 'POST', url: URL, headers, payload: input });
    expect(post.statusCode).toBe(409);
    expect(post.json()).toMatchObject({ code: 'LOG_SOURCES_READONLY' });
    expect(post.body).not.toContain(FAKE_CREDENTIAL);
  });

  it('连接测试成功时返回集群与采样信息', async () => {
    const fetch = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/_cluster/health')) {
        return new Response(JSON.stringify({ cluster_name: 'es-test', status: 'green', number_of_nodes: 3 }), { status: 200 });
      }
      return new Response(JSON.stringify({ took: 1, hits: { total: 12, hits: [{ _id: 'a' }] } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const { app, sessions, store } = await buildApp();
    const headers = sessionCookie(sessions, 'writer');
    const created = (await app.inject({ method: 'POST', url: URL, headers, payload: input })).json();

    const reply = await app.inject({ method: 'POST', url: `${URL}/${created.id}/test`, headers });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ ok: true, cluster: 'es-test', status: 'green', nodes: 3, sampled: 1 });
    expect(reply.body).not.toContain(FAKE_CREDENTIAL);
    // 请求头里带 Basic 认证，但只发给数据源地址。
    const headersSent = fetch.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>);
    expect(headersSent.every((h) => h.authorization?.startsWith('Basic '))).toBe(true);
    expect(store.list()[0]!.hasCredential).toBe(true);
  });

  it('有索引查询权限但没有集群监控权限时仍可连接', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => String(url).endsWith('/_cluster/health')
      ? new Response(null, { status: 403 })
      : Response.json({ hits: { hits: [{ _id: 'sample' }] } })));
    const { app, sessions } = await buildApp();
    const headers = sessionCookie(sessions, 'writer');
    const id = (await app.inject({ method: 'POST', url: URL, headers, payload: input })).json().id;
    const reply = await app.inject({ method: 'POST', url: `${URL}/${id}/test`, headers });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ ok: true, cluster: null, status: null, nodes: null, sampled: 1, elapsedMs: expect.any(Number) });
  });

  it('连接测试失败时返回 502 并带上游原因', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }));
    const { app, sessions } = await buildApp();
    const headers = sessionCookie(sessions, 'writer');
    const created = (await app.inject({ method: 'POST', url: URL, headers, payload: input })).json();
    const reply = await app.inject({ method: 'POST', url: `${URL}/${created.id}/test`, headers });
    expect(reply.statusCode).toBe(502);
    expect(reply.json()).toMatchObject({ code: 'LOG_SOURCE_UNREACHABLE' });
    expect(reply.json().message).toContain('不可达');
  });
});
