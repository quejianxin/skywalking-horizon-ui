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
 * ES 日志检索的编排：时间窗与分页归一到服务端上限，查询解析交给
 * `logs/query.ts`，只读请求交给 `client/elasticsearch.ts`。
 *
 * 检索不可达不是 500：数据源返回 `reachable: false` 和一句可操作原因，页面
 * 据此显示错误横幅，不影响 OAP 侧页面。
 */

import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { esSearch, EsHttpError, type EsSourceRuntime } from '../../client/elasticsearch.js';
import { isLinkableTraceId, MAX_LOG_PAGE_SIZE } from '../../logs/types.js';
import { parseLogQuery, toEsQuery } from '../../logs/query.js';
import type {
  LogSearchRequest,
  LogSearchResponse,
  LogSearchRow,
  LogSourceRecord,
} from '../../logs/types.js';

export const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** ES 默认 `max_result_window` 是 10000，翻页不得越过。 */
export const MAX_RESULT_WINDOW = 10_000;
export const MAX_PAGE = 50;
export const DEFAULT_PAGE_SIZE = 50;
const ES_TIMEOUT = '2s';

/** 时间窗反向或越界：路由按 400 返回，属于请求错误而非数据源故障。 */
export class LogSearchRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogSearchRangeError';
  }
}

export class LogSearchPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogSearchPageError';
  }
}

export interface LogSearchDeps {
  fetch?: FetchLike;
  signal?: AbortSignal;
  now?: () => number;
}

export interface SearchWindow {
  startMs: number;
  endMs: number;
}

/** 显式起止优先；否则用请求窗口，其次数据源默认窗口，统一夹在 7 天内。 */
export function resolveWindow(record: LogSourceRecord, request: LogSearchRequest, nowMs: number): SearchWindow {
  const hasExplicit = request.startMs !== undefined || request.endMs !== undefined;
  if (!hasExplicit) {
    const minutes = request.windowMinutes ?? record.defaultWindowMinutes;
    const span = Math.min(minutes, MAX_WINDOW_MS / 60_000) * 60_000;
    return { startMs: nowMs - span, endMs: nowMs };
  }
  const endMs = request.endMs ?? nowMs;
  const startMs = request.startMs ?? endMs - record.defaultWindowMinutes * 60_000;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new LogSearchRangeError('时间范围不是有效的时间戳');
  }
  if (startMs > endMs) throw new LogSearchRangeError('开始时间不能晚于结束时间');
  if (endMs - startMs > MAX_WINDOW_MS) throw new LogSearchRangeError('时间范围不能超过 7 天');
  return { startMs, endMs };
}

function resolvePaging(request: LogSearchRequest, record: LogSourceRecord): { page: number; pageSize: number; from: number } {
  const page = request.page ?? 1;
  if (page < 1 || page > MAX_PAGE) throw new LogSearchPageError(`页码必须在 1 到 ${MAX_PAGE} 之间`);
  const pageSize = Math.max(1, Math.min(request.pageSize ?? record.maxRows ?? DEFAULT_PAGE_SIZE, record.maxRows, MAX_LOG_PAGE_SIZE));
  const from = (page - 1) * pageSize;
  if (from + pageSize > MAX_RESULT_WINDOW) {
    throw new LogSearchPageError(`翻页深度超过 ${MAX_RESULT_WINDOW} 条，请缩小时间范围或提高过滤条件`);
  }
  return { page, pageSize, from };
}

/**
 * 组装 `_search` 请求体。排序只按时间字段，并声明 `unmapped_type`：索引模式
 * 覆盖多个索引时，缺该字段的索引不会让整次查询报错。
 */
export function buildSearchBody(
  record: LogSourceRecord,
  request: LogSearchRequest,
  window: SearchWindow,
): { body: Record<string, unknown>; page: number; pageSize: number; from: number } {
  const { page, pageSize, from } = resolvePaging(request, record);
  const parsed = parseLogQuery(request.query ?? '');
  const filters: unknown[] = [{
    range: {
      [record.timeField]: {
        gte: window.startMs,
        lte: window.endMs,
        format: 'epoch_millis',
      },
    },
  }];
  if (parsed) filters.push(toEsQuery(parsed, record.messageFields));
  const body = {
    from,
    size: pageSize,
    track_total_hits: MAX_RESULT_WINDOW,
    // 收集上限与 track_total_hits 对齐：命中量过大时提前结束，`truncated` 会
    // 告知页面这是有界样本。不能取页面大小——那会让排序只能看到采样内的文档。
    terminate_after: MAX_RESULT_WINDOW,
    timeout: ES_TIMEOUT,
    sort: [{ [record.timeField]: { order: request.sort === 'asc' ? 'asc' : 'desc', unmapped_type: 'date' } }],
    query: { bool: { filter: filters } },
  };
  return { body, page, pageSize, from };
}

function firstString(source: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const field of fields) {
    const value = source[field];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** ES 时间值可能是毫秒数、秒数或 ISO 字符串；无法识别时返回 null。 */
function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

const LEVEL_FIELDS = ['level', 'severity', 'log.level'] as const;
const SERVICE_FIELDS = ['service', 'serviceName', 'service_name', 'service.name'] as const;

export function toRow(
  hit: { _id: string; _source?: Record<string, unknown> },
  record: LogSourceRecord,
): LogSearchRow {
  const fields = hit._source ?? {};
  const traceId = firstString(fields, record.traceIdFields);
  return {
    id: hit._id,
    timestamp: toEpochMs(fields[record.timeField]),
    message: firstString(fields, record.messageFields) ?? '',
    level: firstString(fields, LEVEL_FIELDS),
    service: firstString(fields, SERVICE_FIELDS),
    traceId: traceId && isLinkableTraceId(traceId) ? traceId : null,
    fields,
  };
}

function totalOf(total: number | { value: number; relation: 'eq' | 'gte' }): number {
  const value = typeof total === 'number' ? total : total?.value;
  if (!Number.isSafeInteger(value) || value < 0) throw new EsHttpError(200, 'Elasticsearch 未返回合法的命中总数');
  return value;
}

export function runtimeOf(record: LogSourceRecord): EsSourceRuntime {
  return {
    url: record.url,
    index: record.index,
    auth: record.auth,
    username: record.username,
    credential: record.credential,
    tlsVerify: record.tlsVerify,
  };
}

export async function runLogSearch(
  record: LogSourceRecord,
  request: LogSearchRequest,
  deps: LogSearchDeps = {},
): Promise<LogSearchResponse> {
  const nowMs = deps.now ? deps.now() : Date.now();
  const window = resolveWindow(record, request, nowMs);
  const { body, page, pageSize, from } = buildSearchBody(record, request, window);
  const base: LogSearchResponse = {
    generatedAt: nowMs,
    source: { id: record.id, name: record.name, index: record.index },
    page,
    pageSize,
    hasNext: false,
    total: 0,
    truncated: false,
    tookMs: 0,
    reachable: true,
    logs: [],
  };
  const startedAt = Date.now();
  try {
    const res = await esSearch(runtimeOf(record), body, {
      fetch: deps.fetch,
      signal: deps.signal,
      timeoutMs: 8000,
    });
    const total = totalOf(res.hits.total);
    return {
      ...base,
      total,
      tookMs: res.took ?? Date.now() - startedAt,
      truncated: res.terminated_early === true || (typeof res.hits.total === 'object' && res.hits.total.relation === 'gte'),
      hasNext: page < MAX_PAGE && from + 2 * pageSize <= MAX_RESULT_WINDOW && total > from + pageSize,
      logs: res.hits.hits.map((hit) => toRow(hit, record)),
    };
  } catch (err) {
    if (err instanceof EsHttpError) {
      return { ...base, reachable: false, error: err.message, tookMs: Date.now() - startedAt };
    }
    throw err;
  }
}
