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

/** 按已显示的日志 Trace ID 读取原生 Trace，不重新检索 Elasticsearch。 */
import type { LinkSpan, LinkedTraceSummary, LogEntity, LogEntityKind, LogTraceLinkResponse } from '../../logs/types.js';

/** 一次串联最多读这么多条 Trace，避免一条宽查询把 OAP 打满。 */
export const MAX_LINKED_TRACES = 50;
/** 同时发给 OAP 的 trace 查询数。 */
const TRACE_CONCURRENCY = 5;

const MQ_COMPONENTS = ['KAFKA', 'ROCKETMQ', 'RABBITMQ', 'PULSAR', 'ACTIVEMQ', 'TIBCO', 'IBMMQ'];
const DB_COMPONENTS = [
  'JDBC', 'MYSQL', 'MARIADB', 'POSTGRESQL', 'ORACLE', 'SQLSERVER', 'DB2', 'MONGODB', 'ELASTICSEARCH',
  'CLICKHOUSE', 'DORIS', 'TIDB', 'OCEANBASE',
];
const RPC_COMPONENTS = ['DUBBO', 'GRPC', 'THRIFT', 'MOTAN', 'BRPC', 'SERVICECOMB'];
const HTTP_COMPONENTS = ['HTTPCLIENT', 'RESTTEMPLATE', 'WEBFLUX', 'FEIGN', 'OKHTTP', 'AXIOS', 'UNDERTOW'];

function upper(value: string | null | undefined): string {
  return (value ?? '').toUpperCase();
}

function componentMatches(component: string, names: readonly string[]): boolean {
  return names.some((name) => component.includes(name));
}

export function classifySpan(span: LinkSpan): LogEntityKind | null {
  const layer = upper(span.layer);
  const component = upper(span.component);
  if (layer === 'MQ' || componentMatches(component, MQ_COMPONENTS)) return 'mq';
  if (layer === 'DATABASE' || componentMatches(component, DB_COMPONENTS)) return 'db';
  if (layer === 'HTTP' || componentMatches(component, HTTP_COMPONENTS)) return 'http';
  if (layer === 'RPC_FRAMEWORK' || componentMatches(component, RPC_COMPONENTS)) return 'rpc';
  return null;
}

function entityName(span: LinkSpan): string {
  return span.component || span.peer || span.endpointName || '(unknown)';
}

interface EntityAccumulator {
  kind: LogEntityKind;
  name: string;
  component: string;
  peer: string;
  spanCount: number;
  traceIds: Set<string>;
}

function addSpanToEntities(bucket: Map<string, EntityAccumulator>, span: LinkSpan, traceId: string): void {
  const kind = classifySpan(span);
  // Entry Span 只代表被调用方，不构成「日志关联到哪个下游」。
  if (!kind || upper(span.type) === 'ENTRY') return;
  const name = entityName(span);
  const key = `${kind}|${upper(span.component)}|${span.peer ?? ''}`;
  const existing = bucket.get(key);
  if (existing) {
    existing.spanCount += 1;
    existing.traceIds.add(traceId);
    return;
  }
  bucket.set(key, {
    kind,
    name,
    component: span.component ?? '',
    peer: span.peer ?? '',
    spanCount: 1,
    traceIds: new Set([traceId]),
  });
}

function groupEntities(bucket: Map<string, EntityAccumulator>): Record<LogEntityKind, LogEntity[]> {
  const groups: Record<LogEntityKind, LogEntity[]> = { mq: [], db: [], rpc: [], http: [] };
  for (const item of bucket.values()) {
    groups[item.kind].push({
      kind: item.kind,
      name: item.name,
      component: item.component,
      peer: item.peer,
      spanCount: item.spanCount,
      traceIds: [...item.traceIds],
    });
  }
  for (const list of Object.values(groups)) list.sort((a, b) => b.spanCount - a.spanCount);
  return groups;
}

export function summarizeTrace(traceId: string, spans: readonly LinkSpan[]): LinkedTraceSummary | null {
  if (spans.length === 0) return null;
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = 0;
  let isError = false;
  const services = new Set<string>();
  for (const span of spans) {
    const start = Number(span.startTime);
    const end = Number(span.endTime);
    if (Number.isFinite(start)) startMs = Math.min(startMs, start);
    if (Number.isFinite(end)) endMs = Math.max(endMs, end);
    if (span.isError === true) isError = true;
    if (span.serviceCode) services.add(span.serviceCode);
  }
  return {
    traceId,
    startMs: Number.isFinite(startMs) ? startMs : 0,
    durationMs: Number.isFinite(startMs) ? Math.max(0, endMs - startMs) : 0,
    isError,
    services: [...services].sort(),
    spanCount: spans.length,
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface TraceLinkDeps {
  spanFetcher: (traceId: string) => Promise<LinkSpan[]>;
  signal?: AbortSignal;
}

export async function runTraceLink(
  rowTraceIds: readonly (string | null)[],
  deps: TraceLinkDeps,
): Promise<LogTraceLinkResponse> {
  const distinctIds = [...new Set(rowTraceIds.filter((id): id is string => id !== null))];
  const attemptedIds = distinctIds.slice(0, MAX_LINKED_TRACES);
  const spanLists = await mapWithConcurrency(attemptedIds, TRACE_CONCURRENCY, async (traceId) => {
    deps.signal?.throwIfAborted();
    try {
      return await deps.spanFetcher(traceId);
    } catch {
      deps.signal?.throwIfAborted();
      return null;
    }
  });
  const traces: LinkedTraceSummary[] = [];
  const bucket = new Map<string, EntityAccumulator>();
  attemptedIds.forEach((traceId, index) => {
    const spans = spanLists[index];
    if (!spans?.length) return;
    const summary = summarizeTrace(traceId, spans);
    if (summary) traces.push(summary);
    for (const span of spans) addSpanToEntities(bucket, span, traceId);
  });
  const linkedIds = new Set(traces.map(({ traceId }) => traceId));
  return {
    traces: traces.sort((a, b) => b.startMs - a.startMs),
    entities: groupEntities(bucket),
    linkedCount: rowTraceIds.filter((id) => id !== null && linkedIds.has(id)).length,
    unlinkedCount: rowTraceIds.filter((id) => id === null).length,
    missingTraceCount: spanLists.filter((spans) => spans?.length === 0).length,
    failedTraceCount: spanLists.filter((spans) => spans === null).length,
    skippedTraceCount: distinctIds.length - attemptedIds.length,
  };
}
