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

/**
 * `/api/diagnosis*` 的 HTTP 契约：`diagnosis:read` 之外的调用一律拒绝，
 * 状态接口只报告是否部署，Trace 读取把上游的失败翻译成可执行的中文提示，
 * 且任何情况下都不回显令牌或诊断服务地址。
 */

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { configSchema } from '../../config/schema.js';
import type { ConfigSource } from '../../config/loader.js';
import { SessionStore } from '../../user/sessions.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { registerDiagnosisRoutes } from './diagnosis.js';

const SUMMARY = {
  traceId: 't1', traceMissing: false, note: '',
  entryCount: 1, databaseCount: 0, inferredCount: 0, lockWaitCount: 0, asyncCount: 0,
};
const PAYLOADS: Record<string, unknown> = {
  summary: SUMMARY,
  'rule-report': { traceId: 't1', modelAvailable: false, modelNote: '', findings: [] },
  sql: { traceId: 't1', traceMissing: false, aggregates: [] },
  locks: { traceId: 't1', traceMissing: false, waits: [] },
  async: { traceId: 't1', traceMissing: false, phases: [] },
  threads: { traceId: 't1', traceMissing: false, threads: [] },
};

function fakeConfig(diagUrl: string): ConfigSource {
  const cfg = configSchema.parse(
    diagUrl === '' ? {} : { diagnosis: { url: diagUrl, token: 'server-side-token' } },
  );
  return { current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {} };
}

function okFetch(): FetchLike {
  return async (input) => {
    const segment = String(input).split('/').pop()!.split('?')[0];
    return new Response(JSON.stringify(PAYLOADS[segment]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function failingFetch(status: number): FetchLike {
  return async () => new Response('denied', { status });
}

async function buildApp(
  diagUrl: string,
  fetch: FetchLike = okFetch(),
): Promise<{ app: FastifyInstance; sessions: SessionStore }> {
  const config = fakeConfig(diagUrl);
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  registerDiagnosisRoutes(app, { config, sessions, fetch });
  await app.ready();
  return { app, sessions };
}

describe('diagnosis routes — access', () => {
  it('401 without a session', async () => {
    const { app } = await buildApp('http://diag:8080');
    expect((await app.inject({ method: 'GET', url: '/api/diagnosis/status' })).statusCode).toBe(401);
    await app.close();
  });

  it('403 for a role without diagnosis:read (viewer), on both routes', async () => {
    const { app, sessions } = await buildApp('http://diag:8080');
    const sid = sessions.create('v', ['viewer']).sid;
    const headers = { cookie: `horizon_sid=${sid}` };
    expect((await app.inject({ method: 'GET', url: '/api/diagnosis/status', headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/diagnosis/traces/t1', headers })).statusCode).toBe(403);
    await app.close();
  });

  it('reports only whether the service is deployed — never its URL or token', async () => {
    const enabled = await buildApp('http://diag:8080');
    const sid = enabled.sessions.create('o', ['operator']).sid;
    const res = await enabled.app.inject({
      method: 'GET', url: '/api/diagnosis/status', headers: { cookie: `horizon_sid=${sid}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true });
    expect(res.body).not.toContain('diag:8080');
    await enabled.app.close();

    const off = await buildApp('');
    const offSid = off.sessions.create('o', ['operator']).sid;
    const offRes = await off.app.inject({
      method: 'GET', url: '/api/diagnosis/status', headers: { cookie: `horizon_sid=${offSid}` },
    });
    expect(offRes.json()).toEqual({ enabled: false });
    await off.app.close();
  });
});

describe('diagnosis routes — trace reads', () => {
  it('serves the aggregated bundle to an operator', async () => {
    const { app, sessions } = await buildApp('http://diag:8080');
    const sid = sessions.create('o', ['operator']).sid;
    const res = await app.inject({
      method: 'GET', url: '/api/diagnosis/traces/t1', headers: { cookie: `horizon_sid=${sid}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ traceId: 't1', traceMissing: false });
    await app.close();
  });

  it('rejects a trace id that would leave the path', async () => {
    const { app, sessions } = await buildApp('http://diag:8080');
    const sid = sessions.create('o', ['operator']).sid;
    const res = await app.inject({
      method: 'GET', url: '/api/diagnosis/traces/a%2Fb', headers: { cookie: `horizon_sid=${sid}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_TRACE_ID');
    await app.close();
  });

  it('503 with a configuration hint when no diagnosis service is deployed', async () => {
    const { app, sessions } = await buildApp('');
    const sid = sessions.create('o', ['operator']).sid;
    const res = await app.inject({
      method: 'GET', url: '/api/diagnosis/traces/t1', headers: { cookie: `horizon_sid=${sid}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('DIAGNOSIS_NOT_CONFIGURED');
    expect(res.json().message).toContain('HORIZON_DIAG_URL');
    await app.close();
  });

  it('502 DIAGNOSIS_AUTH_FAILED with the token hint on an upstream 401 or 403', async () => {
    for (const status of [401, 403]) {
      const { app, sessions } = await buildApp('http://diag:8080', failingFetch(status));
      const sid = sessions.create('o', ['operator']).sid;
      const res = await app.inject({
        method: 'GET', url: '/api/diagnosis/traces/t1', headers: { cookie: `horizon_sid=${sid}` },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe('DIAGNOSIS_AUTH_FAILED');
      expect(res.json().message).toContain('HORIZON_DIAG_TOKEN');
      await app.close();
    }
  });

  it('502 DIAGNOSIS_UNREACHABLE when the service refuses the connection', async () => {
    const down: FetchLike = async () => { throw new Error('connect ECONNREFUSED'); };
    const { app, sessions } = await buildApp('http://diag:8080', down);
    const sid = sessions.create('o', ['operator']).sid;
    const res = await app.inject({
      method: 'GET', url: '/api/diagnosis/traces/t1', headers: { cookie: `horizon_sid=${sid}` },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('DIAGNOSIS_UNREACHABLE');
    await app.close();
  });

  it('502 DIAGNOSIS_FAILED carries the upstream status for any other upstream error', async () => {
    const { app, sessions } = await buildApp('http://diag:8080', failingFetch(500));
    const sid = sessions.create('o', ['operator']).sid;
    const res = await app.inject({
      method: 'GET', url: '/api/diagnosis/traces/t1', headers: { cookie: `horizon_sid=${sid}` },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'DIAGNOSIS_FAILED', details: { upstreamStatus: 500 } });
    await app.close();
  });
});
