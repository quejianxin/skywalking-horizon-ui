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
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import type { LogSearchRequest, LogSourceRecord } from '../../logs/types.js';
import {
  buildSearchBody,
  LogSearchPageError,
  LogSearchRangeError,
  MAX_RESULT_WINDOW,
  MAX_WINDOW_MS,
  resolveWindow,
  runLogSearch,
} from './search.js';

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

const record: LogSourceRecord = {
  id: 'b0f0f0f0-0000-4000-8000-000000000001',
  name: 'prod-es',
  url: 'http://es.example.test:9200',
  index: 'app-logs-*',
  timeField: '@timestamp',
  auth: 'none',
  username: '',
  credential: '',
  tlsVerify: true,
  defaultWindowMinutes: 30,
  maxRows: 200,
  traceIdFields: ['traceId', 'trace_id'],
  messageFields: ['message', 'msg'],
};

/** 逻辑层测试只关心检索参数，sourceId 由路由层填充。 */
function request(overrides: Partial<LogSearchRequest> = {}): LogSearchRequest {
  return { sourceId: record.id, ...overrides };
}

function esResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

describe('时间窗与分页', () => {
  it('默认用数据源窗口，显式起止优先', () => {
    expect(resolveWindow(record, request(), NOW)).toEqual({ startMs: NOW - 30 * 60_000, endMs: NOW });
    expect(resolveWindow(record, request({ startMs: NOW - 60_000, endMs: NOW }), NOW))
      .toEqual({ startMs: NOW - 60_000, endMs: NOW });
    expect(resolveWindow(record, request({ windowMinutes: 10 }), NOW))
      .toEqual({ startMs: NOW - 10 * 60_000, endMs: NOW });
  });

  it('拒绝反向与超过 7 天的时间范围', () => {
    expect(() => resolveWindow(record, request({ startMs: NOW, endMs: NOW - 1 }), NOW)).toThrow(LogSearchRangeError);
    expect(() => resolveWindow(record, request({ startMs: NOW - MAX_WINDOW_MS - 1, endMs: NOW }), NOW)).toThrow('7 天');
  });

  it('翻页深度不得越过 ES 的结果窗口', () => {
    const body = buildSearchBody(record, request({ page: 2, pageSize: 50 }), resolveWindow(record, request(), NOW));
    expect(body).toMatchObject({ page: 2, pageSize: 50, from: 50 });
    // 宽数据源（每页 500）第 50 页会越过 10000 条的结果窗口。
    const wide: LogSourceRecord = { ...record, maxRows: 500 };
    expect(() => buildSearchBody(wide, request({ page: 50 }), resolveWindow(wide, request(), NOW)))
      .toThrow(LogSearchPageError);
    expect(() => buildSearchBody(record, request({ page: 51 }), resolveWindow(record, request(), NOW)))
      .toThrow(LogSearchPageError);
  });
});

describe('检索请求体', () => {
  it('范围过滤 + 解析后的查询 + 时间排序', () => {
    const window = resolveWindow(record, request({ startMs: NOW - 60_000, endMs: NOW }), NOW);
    const { body } = buildSearchBody(record, request({ query: 'level:ERROR timeout' }), window);
    expect(body).toMatchObject({
      from: 0,
      size: 200,
      track_total_hits: MAX_RESULT_WINDOW,
      terminate_after: MAX_RESULT_WINDOW,
      timeout: '2s',
      sort: [{ '@timestamp': { order: 'desc', unmapped_type: 'date' } }],
    });
    const filter = (body.query as { bool: { filter: unknown[] } }).bool.filter;
    expect(filter[0]).toEqual({
      range: { '@timestamp': { gte: window.startMs, lte: window.endMs, format: 'epoch_millis' } },
    });
    expect(filter[1]).toEqual({
      bool: {
        filter: [
          { match: { level: 'ERROR' } },
          { multi_match: { query: 'timeout', fields: ['message', 'msg'], operator: 'and' } },
        ],
      },
    });
  });

  it('空查询只保留范围过滤，升序可选', () => {
    const { body } = buildSearchBody(record, request({ sort: 'asc', pageSize: 10 }), resolveWindow(record, request(), NOW));
    const filter = (body.query as { bool: { filter: unknown[] } }).bool.filter;
    expect(filter).toHaveLength(1);
    expect((body.sort as Array<Record<string, { order: string }>>)[0]!['@timestamp']!.order).toBe('asc');
    expect(body.size).toBe(10);
  });

  it('pageSize 夹在数据源行数上限内', () => {
    const { body } = buildSearchBody(record, request({ pageSize: 1000 }), resolveWindow(record, request(), NOW));
    expect(body.size).toBe(200);
  });
});

describe('runLogSearch', () => {
  it('把命中映射成行，并给出 hasNext', async () => {
    let sent: { url: string; body: string } | null = null;
    const fetch: FetchLike = async (input, init) => {
      sent = { url: String(input), body: String(init?.body ?? '') };
      return esResponse({
        took: 7,
        timed_out: false,
        hits: {
          total: { value: 500, relation: 'eq' },
          hits: [
            {
              _id: 'h1',
              _source: {
                '@timestamp': '2026-11-25T11:59:00Z',
                message: 'Order failed: timeout',
                level: 'ERROR',
                serviceName: 'order',
                trace_id: 'trace-1',
                extra: 1,
              },
            },
          ],
        },
      });
    };
    const result = await runLogSearch(record, request({ pageSize: 50 }), { fetch, now: () => NOW });
    expect(sent!.url).toBe('http://es.example.test:9200/app-logs-*/_search');
    expect(result).toMatchObject({ reachable: true, total: 500, tookMs: 7, hasNext: true, truncated: false });
    expect(result.logs[0]).toEqual({
      id: 'h1',
      timestamp: Date.UTC(2026, 10, 25, 11, 59, 0),
      message: 'Order failed: timeout',
      level: 'ERROR',
      service: 'order',
      traceId: 'trace-1',
      fields: {
        '@timestamp': '2026-11-25T11:59:00Z',
        message: 'Order failed: timeout',
        level: 'ERROR',
        serviceName: 'order',
        trace_id: 'trace-1',
        extra: 1,
      },
    });
  });

  it('秒级时间戳换算成毫秒，无法识别的字段为 null', async () => {
    const fetch: FetchLike = async () => esResponse({
      took: 1,
      timed_out: false,
      hits: { total: 1, hits: [{ _id: 'h2', _source: { '@timestamp': 1_796_000_000, msg: '' } }] },
    });
    const result = await runLogSearch(record, request(), { fetch, now: () => NOW });
    expect(result.logs[0]).toMatchObject({ timestamp: 1_796_000_000_000, message: '', level: null, traceId: null });
  });

  it('ES 不可达时返回 reachable=false，不抛错', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const result = await runLogSearch(record, request(), { fetch, now: () => NOW });
    expect(result.reachable).toBe(false);
    expect(result.error).toContain('不可达');
    expect(result.logs).toEqual([]);
  });

  it('ES 4xx 返回状态码但不暴露响应正文', async () => {
    const fetch: FetchLike = async () => esResponse({ error: { reason: 'index_not_found_exception' } }, 404);
    const result = await runLogSearch(record, request(), { fetch, now: () => NOW });
    expect(result.reachable).toBe(false);
    expect(result.error).not.toContain('index_not_found_exception');
    expect(result.error).toContain('404');
  });

  it('不跟随重定向，也不回显重定向地址', async () => {
    const fetch = vi.fn<FetchLike>(async () => new Response(null, {
      status: 302, headers: { location: 'https://other.example.test/' },
    }));
    const result = await runLogSearch(record, request(), { fetch, now: () => NOW });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('manual');
    expect(result).toMatchObject({ reachable: false, logs: [] });
    expect(result.error).toContain('重定向');
    expect(result.error).not.toContain('other.example.test');
  });

  it.each([{ timed_out: true }, { _shards: { failed: 1 } }])('不把不完整的结果当成成功：%j', async (failure) => {
    const fetch: FetchLike = async () => esResponse({ hits: { total: 0, hits: [] }, ...failure });
    const result = await runLogSearch(record, request(), { fetch, now: () => NOW });
    expect(result).toMatchObject({ reachable: false, logs: [] });
    expect(result.error).toContain('未返回完整结果');
  });

  it('报告命中数下界，不提供会越过结果窗口的下一页', async () => {
    const fetch: FetchLike = async () => esResponse({ hits: { total: { value: 10_000, relation: 'gte' }, hits: [] } });
    const wide = { ...record, maxRows: 300 };
    const result = await runLogSearch(wide, request({ page: 33 }), { fetch, now: () => NOW });
    expect(result).toMatchObject({ reachable: true, truncated: true, hasNext: false });
  });

  it('语法错误直接抛出，由路由返回 400', async () => {
    const fetch: FetchLike = async () => esResponse({ hits: { total: 0, hits: [] } });
    await expect(runLogSearch(record, request({ query: 'message:"abc' }), { fetch, now: () => NOW }))
      .rejects.toThrow('引号未闭合');
  });
});
