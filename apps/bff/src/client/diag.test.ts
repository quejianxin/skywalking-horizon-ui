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
 * 诊断服务客户端：一次读取六个只读接口并合成一个结果。这里钉住三件事——
 * 请求真的并发发往六个路径、令牌只出现在服务端请求头、任何一段失败都让
 * 整个读取失败（半份诊断会被误读成「没有锁等待」）。
 */

import { describe, expect, it } from 'vitest';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import {
  DiagnosisHttpError,
  isDiagnosisConfigured,
  isValidDiagnosisTraceId,
  readTraceDiagnosis,
  type DiagConfig,
} from './diag.js';

const CFG: DiagConfig = { url: 'http://diag.local:8080/', token: 'tok-1', timeoutMs: 5000 };

const PAYLOADS: Record<string, unknown> = {
  summary: {
    traceId: 't1', traceMissing: false, note: '',
    entryCount: 2, databaseCount: 3, inferredCount: 1, lockWaitCount: 0, asyncCount: 1,
  },
  'rule-report': {
    traceId: 't1', modelAvailable: false, modelNote: '规则诊断（模型未参与）',
    findings: [{ ruleId: 'slow-sql', severity: 'critical', title: '慢 SQL', detail: '', evidence: [] }],
  },
  sql: {
    traceId: 't1', traceMissing: false,
    aggregates: [{ template: 'SELECT 1 FROM pg_sleep(?)', count: 1, totalMs: 1200, minMs: 1200, maxMs: 1200, samples: [] }],
  },
  locks: { traceId: 't1', traceMissing: false, waits: [] },
  async: { traceId: 't1', traceMissing: false, phases: [] },
  threads: {
    traceId: 't1', traceMissing: false,
    threads: [{ serviceInstance: 'i1', threadKey: 'k', threadName: 'http-nio-8080-exec-1', spanCount: 2, totalMs: 1300, maxMs: 1200 }],
  },
};

interface Recorded {
  url: string;
  headers: Record<string, string>;
}

/** 按路径尾段回答；记录每次请求的 URL 与请求头。 */
function fakeFetch(options: { failOn?: string; transportError?: boolean } = {}): {
  fetch: FetchLike;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string> ?? {}) } });
    const segment = url.split('/').pop()!.split('?')[0];
    if (options.transportError) throw new Error('connect ECONNREFUSED');
    if (options.failOn === segment) {
      return new Response('upstream says no', { status: 500 });
    }
    return new Response(JSON.stringify(PAYLOADS[segment]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

describe('readTraceDiagnosis', () => {
  it('reads all six endpoints under the trace, with samples capped', async () => {
    const { fetch, calls } = fakeFetch();
    const bundle = await readTraceDiagnosis(CFG, 't1', { fetch });

    expect(calls).toHaveLength(6);
    expect(calls.map((c) => c.url).sort()).toEqual([
      'http://diag.local:8080/diagnosis/traces/t1/async',
      'http://diag.local:8080/diagnosis/traces/t1/locks',
      'http://diag.local:8080/diagnosis/traces/t1/rule-report',
      'http://diag.local:8080/diagnosis/traces/t1/sql?samples=5',
      'http://diag.local:8080/diagnosis/traces/t1/summary',
      'http://diag.local:8080/diagnosis/traces/t1/threads',
    ]);
    expect(calls.every((c) => c.headers.authorization === 'Bearer tok-1')).toBe(true);
    expect(bundle.traceMissing).toBe(false);
    expect(bundle.summary.entryCount).toBe(2);
    expect(bundle.ruleReport.findings[0].severity).toBe('critical');
    expect(bundle.threads.threads[0].threadName).toBe('http-nio-8080-exec-1');
  });

  it('encodes a trace id that carries reserved characters', async () => {
    const { fetch, calls } = fakeFetch();
    await readTraceDiagnosis({ ...CFG, token: '' }, 'svc:a', { fetch });
    expect(calls[0].url).toContain('/diagnosis/traces/svc%3Aa/summary');
    // 没有令牌就不带 Authorization 头，也不带空 Bearer。
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it('carries traceMissing from the summary into the bundle', async () => {
    const base = fakeFetch();
    const missing: FetchLike = async (input, init) => {
      if (String(input).endsWith('/summary')) {
        return new Response(JSON.stringify({ ...PAYLOADS.summary, traceMissing: true }), { status: 200 });
      }
      return base.fetch(input, init);
    };
    const bundle = await readTraceDiagnosis(CFG, 't1', { fetch: missing });
    expect(bundle.traceMissing).toBe(true);
  });

  it('fails the whole read when one endpoint fails, rather than returning a partial diagnosis', async () => {
    const { fetch } = fakeFetch({ failOn: 'locks' });
    await expect(readTraceDiagnosis(CFG, 't1', { fetch })).rejects.toMatchObject({
      name: 'DiagnosisHttpError',
      status: 500,
    });
  });

  it('reports an unreachable service as status 0 with the address in the message', async () => {
    const { fetch } = fakeFetch({ transportError: true });
    const err = await readTraceDiagnosis(CFG, 't1', { fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiagnosisHttpError);
    expect((err as DiagnosisHttpError).status).toBe(0);
    expect((err as DiagnosisHttpError).message).toContain('http://diag.local:8080/');
  });
});

describe('configuration and trace-id guards', () => {
  it('treats a blank URL as not deployed and any http(s) URL as deployed', () => {
    expect(isDiagnosisConfigured({ url: '', token: '', timeoutMs: 1 })).toBe(false);
    expect(isDiagnosisConfigured({ url: '  ', token: '', timeoutMs: 1 })).toBe(false);
    expect(isDiagnosisConfigured(CFG)).toBe(true);
  });

  it('accepts the forms a trace id takes and refuses path separators', () => {
    for (const ok of ['t1', 'a.b-c_d:001', 'A'.repeat(128)]) {
      expect(isValidDiagnosisTraceId(ok)).toBe(true);
    }
    for (const bad of ['', '..', 'a/b', 'a b', 'a?b', 'A'.repeat(129)]) {
      expect(isValidDiagnosisTraceId(bad)).toBe(false);
    }
  });
});
