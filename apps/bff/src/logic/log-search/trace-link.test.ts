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

import { describe, expect, it, vi } from 'vitest';
import type { LinkSpan } from '../../logs/types.js';
import {
  classifySpan,
  MAX_LINKED_TRACES,
  runTraceLink,
  summarizeTrace,
} from './trace-link.js';

function span(overrides: Partial<LinkSpan> = {}): LinkSpan {
  return {
    serviceCode: 'order',
    startTime: 1_000,
    endTime: 1_100,
    endpointName: 'GET:/order',
    type: 'Exit',
    peer: '',
    component: '',
    isError: false,
    layer: '',
    ...overrides,
  };
}

describe('Span 归类', () => {
  it('按 layer 与 component 归到 MQ / DB / HTTP / RPC', () => {
    expect(classifySpan(span({ layer: 'MQ' }))).toBe('mq');
    expect(classifySpan(span({ layer: 'DATABASE' }))).toBe('db');
    expect(classifySpan(span({ layer: 'HTTP' }))).toBe('http');
    expect(classifySpan(span({ layer: 'RPC_FRAMEWORK' }))).toBe('rpc');
    expect(classifySpan(span({ component: 'Kafka' }))).toBe('mq');
    expect(classifySpan(span({ component: 'Mysql/JDBI' }))).toBe('db');
    expect(classifySpan(span({ component: 'gRPC' }))).toBe('rpc');
    expect(classifySpan(span({ component: 'HttpClient' }))).toBe('http');
    expect(classifySpan(span({ component: 'SpringMVC', layer: 'SpringMVC' }))).toBeNull();
  });

  it('聚合 Trace 摘要：起止、时长、错误、服务与 Span 数', () => {
    const summary = summarizeTrace('t1', [
      span({ startTime: 2_000, endTime: 2_300, serviceCode: 'order' }),
      span({ startTime: 1_500, endTime: 2_500, serviceCode: 'pay', isError: true }),
      span({ startTime: 1_800, endTime: 1_900, serviceCode: 'order' }),
    ]);
    expect(summary).toEqual({
      traceId: 't1',
      startMs: 1_500,
      durationMs: 1_000,
      isError: true,
      services: ['order', 'pay'],
      spanCount: 3,
    });
    expect(summarizeTrace('t2', [])).toBeNull();
  });
});

describe('runTraceLink', () => {
  it('没有可用 Trace ID 时不读 OAP，也不做时间近似关联', async () => {
    const spanFetcher = vi.fn(async () => [span()]);
    const result = await runTraceLink([null, null], { spanFetcher });
    expect(result).toMatchObject({ linkedCount: 0, unlinkedCount: 2, traces: [] });
    expect(spanFetcher).not.toHaveBeenCalled();
  });

  it('按 traceId 去重读取 OAP，并归出 MQ / DB / RPC / HTTP 实体', async () => {
    const spans: Record<string, LinkSpan[]> = {
      'trace-a': [
        span({ type: 'Entry', layer: 'SpringMVC', component: 'SpringMVC' }),
        span({ layer: 'DATABASE', component: 'MYSQL', peer: 'mysql://db:3306', startTime: 1_000, endTime: 1_050 }),
        span({ layer: 'DATABASE', component: 'MYSQL', peer: 'mysql://db:3306', startTime: 1_060, endTime: 1_120, isError: true }),
        span({ layer: 'MQ', component: 'KAFKA', peer: 'kafka:9092', startTime: 1_130, endTime: 1_200 }),
        span({ layer: 'HTTP', component: 'HTTPCLIENT', peer: 'https://pay', startTime: 1_210, endTime: 1_300 }),
      ],
    };
    const spanFetcher = vi.fn(async (traceId: string) => spans[traceId] ?? []);
    const result = await runTraceLink(['trace-a', 'trace-a'], { spanFetcher });
    expect(spanFetcher).toHaveBeenCalledTimes(1);
    expect(result.linkedCount).toBe(2);
    expect(result.unlinkedCount).toBe(0);
    expect(result).toMatchObject({ missingTraceCount: 0, failedTraceCount: 0, skippedTraceCount: 0 });
    expect(result.traces).toEqual([{
      traceId: 'trace-a',
      startMs: 1_000,
      durationMs: 300,
      isError: true,
      services: ['order'],
      spanCount: 5,
    }]);
    expect(result.entities.db).toEqual([{
      kind: 'db',
      name: 'MYSQL',
      component: 'MYSQL',
      peer: 'mysql://db:3306',
      spanCount: 2,
      traceIds: ['trace-a'],
    }]);
    expect(result.entities.mq[0]).toMatchObject({ kind: 'mq', name: 'KAFKA', spanCount: 1 });
    expect(result.entities.http[0]).toMatchObject({ kind: 'http', peer: 'https://pay', spanCount: 1 });
    // Entry Span 只代表被调用方，不进入下游实体。
    expect(result.entities.rpc).toEqual([]);
  });

  it('OAP 里找不到 traceId 与读取失败都如实缺席', async () => {
    const spanFetcher = vi.fn(async (traceId: string) => {
      if (traceId === 'trace-bad') throw new Error('OAP 500');
      return [];
    });
    const result = await runTraceLink(['trace-gone', 'trace-bad', 'trace-gone'], { spanFetcher });
    expect(result).toMatchObject({ linkedCount: 0, traces: [], missingTraceCount: 1, failedTraceCount: 1 });
  });

  it('Trace 按开始时间倒序，且一次最多读固定条数', async () => {
    const hits = Array.from({ length: MAX_LINKED_TRACES + 1 }, (_, index) => `trace-${index}`);
    const spanFetcher = vi.fn(async (traceId: string) => {
      const index = Number(traceId.slice('trace-'.length));
      return [span({ startTime: 1_000 + index, endTime: 1_100 + index })];
    });
    const result = await runTraceLink(hits, { spanFetcher });
    expect(spanFetcher).toHaveBeenCalledTimes(MAX_LINKED_TRACES);
    expect(result.traces).toHaveLength(MAX_LINKED_TRACES);
    expect(result.skippedTraceCount).toBe(1);
    expect(result.traces[0]!.startMs).toBe(1_000 + MAX_LINKED_TRACES - 1);
    expect(result.traces.at(-1)!.startMs).toBe(1_000);
  });

  it('取消后不再调度下一批查询', async () => {
    const controller = new AbortController();
    const ids = Array.from({ length: MAX_LINKED_TRACES }, (_, index) => `trace-${index}`);
    const spanFetcher = vi.fn(async () => {
      controller.abort();
      return [span()];
    });
    await expect(runTraceLink(ids, { spanFetcher, signal: controller.signal })).rejects.toThrow(/aborted/i);
    expect(spanFetcher).toHaveBeenCalledTimes(1);
  });
});
