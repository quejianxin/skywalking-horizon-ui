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
 * 日志检索页的状态契约：换数据源先清空再读、失败的检索不留下上一批行、
 * 串联结果只对产生它的那批日志成立。这三条都属于「残留的旧数据会被读成
 * 新状态」的问题，界面上看不出来，只能在这里钉住。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { EsLogRow, EsLogSearchRequest, EsLogSearchResponse, EsLogTraceLinkRequest, EsLogTraceLinkResponse } from '@/api/client';

const sources = vi.fn(async () => ({
  sources: [
    { id: 'a', name: 'prod-es', index: 'app-logs-*' },
    { id: 'b', name: 'audit-es', index: 'audit-*' },
  ],
}));
const search = vi.fn(async (_req: EsLogSearchRequest, _signal?: AbortSignal): Promise<EsLogSearchResponse> => response());
const traceLink = vi.fn(async (_req: EsLogTraceLinkRequest, _signal?: AbortSignal): Promise<EsLogTraceLinkResponse> => ({
  traces: [], entities: { mq: [], db: [], rpc: [], http: [] },
  linkedCount: 0, unlinkedCount: 1, missingTraceCount: 0, failedTraceCount: 0, skippedTraceCount: 0,
}));

class BffApiError extends Error {
  cancelled = false;
  body: unknown;
  constructor(message: string, body?: unknown) {
    super(message);
    this.body = body;
  }
}

vi.mock('@/api/client', () => ({
  bff: { logSearch: { sources: () => sources(), search: (r: EsLogSearchRequest, s?: AbortSignal) => search(r, s), traceLink: (r: EsLogTraceLinkRequest, s?: AbortSignal) => traceLink(r, s) } },
  BffApiError,
  describeApiError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

const { useLogSearch, fieldStatsOf } = await import('./useLogSearch');

function row(id: string): EsLogRow {
  return { id, timestamp: 1, message: `m${id}`, level: 'ERROR', service: null, traceId: null, fields: { message: `m${id}` } };
}

function response(over: Partial<EsLogSearchResponse> = {}): EsLogSearchResponse {
  return {
    generatedAt: 0,
    source: { id: 'a', name: 'prod-es', index: 'app-logs-*' },
    page: 1, pageSize: 50, hasNext: false, total: 1, truncated: false, tookMs: 3,
    reachable: true, logs: [row('1')],
    ...over,
  };
}

const Harness = defineComponent({ setup: () => ({ s: useLogSearch() }), template: '<div />' });
type Search = ReturnType<typeof useLogSearch>;

const mounted: VueWrapper[] = [];
function open(): Search {
  const w = mount(Harness);
  mounted.push(w);
  // 挂在 `s` 上而不是直接返回：vm 的顶层 ref 会被自动解包，这里要的是原样的 ref。
  return (w.vm as unknown as { s: Search }).s;
}

/** 挂载并等首个数据源被选中、首个检索落地。 */
async function openLoaded(): Promise<Search> {
  const s = open();
  void s.loadSources();
  await flushPromises();
  return s;
}

function lastRequest(): EsLogSearchRequest {
  const call = search.mock.calls.at(-1);
  if (!call) throw new Error('no search was sent');
  return call[0];
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount();
  sources.mockClear();
  search.mockClear();
  traceLink.mockClear();
  search.mockImplementation(async () => response());
});

describe('日志检索的状态', () => {
  it('选中首个数据源后立即按默认条件检索', async () => {
    const s = await openLoaded();
    expect(s.sourceId.value).toBe('a');
    expect(search).toHaveBeenCalledTimes(1);
    expect(lastRequest()).toEqual({
      sourceId: 'a', query: undefined, page: 1, pageSize: 50, sort: 'desc',
      startMs: expect.any(Number), endMs: expect.any(Number),
    });
    expect(s.result.value?.logs).toHaveLength(1);
  });

  it('换数据源先清空上一批行，再读新的', async () => {
    const s = await openLoaded();
    expect(s.result.value).not.toBeNull();

    let settle!: (r: EsLogSearchResponse) => void;
    search.mockImplementationOnce(() => new Promise<EsLogSearchResponse>((resolve) => { settle = resolve; }));
    s.sourceId.value = 'b';
    await flushPromises();

    expect(s.result.value, '上一批行还留在页面上').toBeNull();
    expect(s.ranOnce.value).toBe(false);
    expect(lastRequest().sourceId).toBe('b');

    settle(response({ source: { id: 'b', name: 'audit-es', index: 'audit-*' } }));
    await flushPromises();
    expect(s.result.value?.source.id).toBe('b');
  });

  it('失败的检索不留下上一批行，并带出语法错误位置', async () => {
    const s = await openLoaded();
    search.mockImplementationOnce(async () => {
      throw new BffApiError('bad query', { error: 'invalid_query', position: 12 });
    });
    await s.run();
    expect(s.result.value).toBeNull();
    expect(s.error.value).toBe('bad query');
    expect(s.errorPosition.value).toBe(12);
  });

  it('自定义范围两端倒置时不发请求', async () => {
    const s = await openLoaded();
    search.mockClear();
    s.customRange.value = true;
    s.customStart.value = '2026-11-25T10:00';
    s.customEnd.value = '2026-11-25T09:00';
    expect(s.rangeValid.value).toBe(false);
    await s.run();
    expect(search).not.toHaveBeenCalled();
  });

  it('自定义范围发 startMs/endMs，不再发 windowMinutes', async () => {
    const s = await openLoaded();
    s.customRange.value = true;
    s.customStart.value = '2026-11-25T09:00';
    s.customEnd.value = '2026-11-25T10:00';
    await s.run();
    const req = lastRequest();
    expect(req.startMs).toBe(new Date('2026-11-25T09:00').getTime());
    expect(req.endMs).toBe(new Date('2026-11-25T10:00').getTime());
    expect(req).not.toHaveProperty('windowMinutes');
  });

  it('翻页沿用条件，改每页条数回到第 1 页', async () => {
    search.mockImplementation(async () => response({ hasNext: true }));
    const s = await openLoaded();
    expect(s.hasMore.value).toBe(true);

    const applied = lastRequest();
    s.query.value = 'unsubmitted';
    s.windowMinutes.value = 15;
    s.nextPage();
    await flushPromises();
    expect(lastRequest()).toEqual({ ...applied, page: 2 });

    s.previousPage();
    await flushPromises();
    expect(lastRequest().page).toBe(1);

    s.changePageSize(100);
    await flushPromises();
    expect(lastRequest().page).toBe(1);
    expect(lastRequest().pageSize).toBe(100);
  });

  it('丢弃较晚返回的旧检索，即使请求忽略取消', async () => {
    const s = await openLoaded();
    let settle!: (r: EsLogSearchResponse) => void;
    search.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const pending = s.run();
    expect(s.result.value).toBeNull();
    search.mockResolvedValueOnce(response({ logs: [row('new')] }));
    await s.run();
    settle(response({ logs: [row('stale')] }));
    await pending;
    expect(s.result.value?.logs.map(({ id }) => id)).toEqual(['new']);
  });

  it('只串联当前页的 Trace ID；重新检索作废串联结果', async () => {
    const s = await openLoaded();
    await s.linkTraces();
    expect(traceLink).toHaveBeenCalledTimes(1);
    expect(traceLink.mock.calls[0]![0]).toEqual({ rowTraceIds: [null] });
    expect(s.link.value).not.toBeNull();

    await s.run();
    expect(s.link.value, '上一批日志的串联结果还留着').toBeNull();
  });
});

describe('字段侧栏', () => {
  it('按覆盖行数降序排列本页字段', () => {
    const stats = fieldStatsOf([
      { ...row('1'), fields: { message: 'x', traceId: 't' } },
      { ...row('2'), fields: { message: 'y' } },
    ]);
    expect(stats).toEqual([{ key: 'message', rows: 2 }, { key: 'traceId', rows: 1 }]);
  });

  it('只把能直接写进查询的字段名补进查询框', async () => {
    const s = await openLoaded();
    expect(s.appendField('message')).toBe(true);
    expect(s.query.value).toBe('message:');
    expect(s.appendField('kubernetes.labels.app')).toBe(true);
    expect(s.query.value).toBe('message: kubernetes.labels.app:');
    expect(s.appendField('has space')).toBe(false);
    expect(s.query.value).toBe('message: kubernetes.labels.app:');
  });
});
