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
 * Elasticsearch 日志检索页的状态。
 *
 * 一个数据源一次只跑一条查询：换数据源先清空上一批结果再读（级联清空），
 * 翻页沿用当前条件，重新检索则把页码归 1 并作废上一批串联结果——串联结果只
 * 对产生它的那批日志成立。
 *
 * 检索不可达不是异常：服务端以 200 返回 `reachable: false` 和一句原因，页面
 * 显示横幅而不是清空页面；只有请求本身非法（语法、窗口、分页）才是错误。
 */

import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  bff,
  BffApiError,
  describeApiError,
  type EsLogRow,
  type EsLogSearchRequest,
  type EsLogSearchResponse,
  type EsLogSourceSummary,
  type EsLogTraceLinkResponse,
} from '@/api/client';

/** 与服务端 `MAX_PAGE` 一致：翻页不得越过 ES 的 10000 条结果窗口。 */
const MAX_PAGE = 50;
export const PAGE_SIZES = [50, 100, 200] as const;

/** 时间窗预设，单位分钟；`10080` 分钟正好是服务端 7 天上限。
 *  label 沿用顶栏时间范围已有的文案键，两个入口的窗口名称保持一致。 */
export const WINDOW_PRESETS = [
  { minutes: 15, label: 'Last 15 minutes' },
  { minutes: 60, label: 'Last 1 hour' },
  { minutes: 360, label: 'Last 6 hours' },
  { minutes: 1440, label: 'Last 24 hours' },
  { minutes: 10_080, label: 'Last 7 days' },
] as const;

/** 字段侧栏的一行：这一页里有多少条日志带有该字段。 */
export interface FieldStat {
  key: string;
  rows: number;
}

/** 可以点进查询框的字段名：SLS 子集语法里不带引号即可写的键。 */
const QUERYABLE_FIELD = /^[A-Za-z0-9_.@-]+$/;

function toMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function isCancelled(err: unknown): boolean {
  return err instanceof BffApiError && err.cancelled === true;
}

function positionOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null || !('body' in err)) return null;
  const body = (err as { body: unknown }).body;
  if (typeof body !== 'object' || body === null) return null;
  const position = (body as Record<string, unknown>).position;
  return typeof position === 'number' ? position : null;
}

/** 这一页里出现过的顶层字段，按覆盖行数降序——不是索引的完整字段表。 */
export function fieldStatsOf(logs: EsLogRow[]): FieldStat[] {
  const counts = new Map<string, number>();
  for (const row of logs) {
    for (const [key, value] of Object.entries(row.fields)) {
      if (value === null || value === undefined || value === '') continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts].map(([key, rows]) => ({ key, rows }))
    .sort((a, b) => b.rows - a.rows || a.key.localeCompare(b.key));
}

export function useLogSearch() {
  /* ── 数据源 ──────────────────────────────────────────────────────── */
  const sources = ref<EsLogSourceSummary[]>([]);
  const sourcesLoading = ref(true);
  const sourcesError = ref('');
  const sourceId = ref('');

  /* ── 检索条件 ────────────────────────────────────────────────────── */
  const query = ref('');
  const windowMinutes = ref(60);
  const customRange = ref(false);
  const customStart = ref<string | null>(null);
  const customEnd = ref<string | null>(null);
  const sort = ref<'asc' | 'desc'>('desc');
  const pageSize = ref<number>(50);
  const page = ref(1);

  /* ── 结果 ────────────────────────────────────────────────────────── */
  const result = ref<EsLogSearchResponse | null>(null);
  const running = ref(false);
  const error = ref('');
  const errorPosition = ref<number | null>(null);
  const ranOnce = ref(false);

  /* ── 串联 ────────────────────────────────────────────────────────── */
  const link = ref<EsLogTraceLinkResponse | null>(null);
  const linking = ref(false);
  const linkError = ref('');

  let applied: EsLogSearchRequest | null = null;
  let searchController: AbortController | null = null;
  let linkController: AbortController | null = null;

  const canSearch = computed<boolean>(() => sourceId.value !== '' && !running.value);
  const hasMore = computed<boolean>(() => page.value < MAX_PAGE && (result.value?.hasNext ?? false));
  const fields = computed<FieldStat[]>(() => fieldStatsOf(result.value?.logs ?? []));

  /** 自定义范围两端都能解析，且结束晚于开始；预设窗口永远成立。 */
  const rangeValid = computed<boolean>(() => {
    if (!customRange.value) return true;
    const start = toMs(customStart.value);
    const end = toMs(customEnd.value);
    return start !== undefined && end !== undefined && end > start;
  });

  function buildRequest(): EsLogSearchRequest {
    const endMs = customRange.value ? toMs(customEnd.value) : Date.now();
    const startMs = customRange.value || endMs === undefined
      ? toMs(customStart.value) : endMs - windowMinutes.value * 60_000;
    return {
      sourceId: sourceId.value,
      query: query.value.trim() || undefined,
      page: 1,
      pageSize: pageSize.value,
      sort: sort.value,
      startMs,
      endMs,
    };
  }

  function resetLinkage(): void {
    linkController?.abort();
    linkController = null;
    linking.value = false;
    link.value = null;
    linkError.value = '';
  }

  async function readPage(request: EsLogSearchRequest): Promise<void> {
    searchController?.abort();
    const controller = new AbortController();
    searchController = controller;
    running.value = true;
    error.value = '';
    errorPosition.value = null;
    result.value = null;
    resetLinkage();
    page.value = request.page ?? 1;
    try {
      const data = await bff.logSearch.search(request, controller.signal);
      if (controller.signal.aborted || searchController !== controller) return;
      result.value = data;
      ranOnce.value = true;
    } catch (err) {
      if (controller.signal.aborted || searchController !== controller || isCancelled(err)) return;
      ranOnce.value = true;
      error.value = describeApiError(err);
      errorPosition.value = positionOf(err);
    } finally {
      if (searchController === controller) running.value = false;
    }
  }

  async function run(): Promise<void> {
    if (!sourceId.value || !rangeValid.value) return;
    applied = buildRequest();
    await readPage(applied);
  }

  function nextPage(): void {
    if (!applied || !hasMore.value || running.value) return;
    void readPage({ ...applied, page: page.value + 1 });
  }

  function previousPage(): void {
    if (!applied || page.value <= 1 || running.value) return;
    void readPage({ ...applied, page: page.value - 1 });
  }

  function changePageSize(size: number): void {
    pageSize.value = size;
    if (!applied) return void run();
    applied = { ...applied, pageSize: size };
    void readPage(applied);
  }

  async function linkTraces(): Promise<void> {
    if (!result.value?.reachable || running.value || linking.value || link.value) return;
    const rowTraceIds = result.value.logs.map(({ traceId }) => traceId);
    if (!rowTraceIds.length) return;
    const controller = new AbortController();
    linkController = controller;
    linking.value = true;
    linkError.value = '';
    try {
      const data = await bff.logSearch.traceLink({ rowTraceIds }, controller.signal);
      if (controller.signal.aborted || linkController !== controller) return;
      link.value = data;
    } catch (err) {
      if (controller.signal.aborted || linkController !== controller || isCancelled(err)) return;
      linkError.value = describeApiError(err);
    } finally {
      if (linkController === controller) linking.value = false;
    }
  }

  async function loadSources(): Promise<void> {
    sourcesLoading.value = true;
    sourcesError.value = '';
    try {
      const list = await bff.logSearch.sources();
      sources.value = list.sources;
      if (!sourceId.value && list.sources.length > 0) sourceId.value = list.sources[0]!.id;
    } catch (err) {
      sourcesError.value = describeApiError(err);
    } finally {
      sourcesLoading.value = false;
    }
  }

  /* 换数据源：上一批行与串联都不再成立，先清空再读新的。首次赋值也走这里，
   * 所以 `loadSources` 选中首个数据源后不需要再单独触发一次。 */
  watch(sourceId, (next, previous) => {
    if (next === previous) return;
    searchController?.abort();
    searchController = null;
    applied = null;
    running.value = false;
    result.value = null;
    ranOnce.value = false;
    error.value = '';
    page.value = 1;
    resetLinkage();
    if (next) void run();
  });

  onBeforeUnmount(() => {
    searchController?.abort();
    linkController?.abort();
  });

  /** 把一个字段名补进查询框；不可直接键入的键（含空格、冒号等）原样返回 false。 */
  function appendField(key: string): boolean {
    if (!QUERYABLE_FIELD.test(key)) return false;
    const trimmed = query.value.trim();
    query.value = trimmed === '' ? `${key}:` : `${trimmed} ${key}:`;
    return true;
  }

  return {
    sources, sourcesLoading, sourcesError, sourceId,
    query, windowMinutes, customRange, customStart, customEnd, sort, pageSize, page,
    result, running, error, errorPosition, ranOnce,
    link, linking, linkError,
    canSearch, hasMore, fields, rangeValid,
    run, nextPage, previousPage, changePageSize, linkTraces, loadSources, appendField,
  };
}
