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

/** Elasticsearch 日志检索：数据源下拉、SLS 子集语法检索、日志串到 OAP Trace。
 *
 * 与 `bff.adminLogSources` 分属两套权限——这里只需要 `logs:read`，所以数据源
 * 列表只带 id、名称与索引，没有地址、凭据和字段映射。 */

import type { BffClient } from '../client';

export interface EsLogSourceSummary {
  id: string;
  name: string;
  index: string;
}

export interface EsLogSourceList {
  sources: EsLogSourceSummary[];
}

/** 检索入参。窗口与分页都有服务端上限：窗口 ≤ 7 天、page × pageSize 有界。 */
export interface EsLogSearchRequest {
  sourceId: string;
  /** SLS 子集语法；空串表示只按时间窗匹配。 */
  query?: string;
  startMs?: number;
  endMs?: number;
  windowMinutes?: number;
  page?: number;
  pageSize?: number;
  sort?: 'asc' | 'desc';
}

export interface EsLogRow {
  /** ES `_id`；同一页结果里作为行键。 */
  id: string;
  /** 毫秒时间戳；时间字段缺失或不是数字时为 null。 */
  timestamp: number | null;
  message: string;
  level: string | null;
  service: string | null;
  traceId: string | null;
  /** 原始 `_source`，供字段侧栏与展开行使用。 */
  fields: Record<string, unknown>;
}

export interface EsLogSearchResponse {
  generatedAt: number;
  source: { id: string; name: string; index: string };
  page: number;
  pageSize: number;
  hasNext: boolean;
  /** 命中总数；ES 可能只报告下界（track_total_hits 上限）。 */
  total: number;
  /** true = ES 在收集上限处提前结束，结果只是有界样本。 */
  truncated: boolean;
  tookMs: number;
  reachable: boolean;
  error?: string;
  logs: EsLogRow[];
}

export type LogEntityKind = 'mq' | 'db' | 'rpc' | 'http';

/** 从关联 Trace 的 Span 汇总出的一个下游实体。 */
export interface LogEntity {
  kind: LogEntityKind;
  name: string;
  component: string;
  peer: string;
  spanCount: number;
  traceIds: string[];
}

export interface LinkedTraceSummary {
  traceId: string;
  startMs: number;
  durationMs: number;
  isError: boolean;
  services: string[];
  spanCount: number;
}

export interface EsLogTraceLinkRequest {
  rowTraceIds: Array<string | null>;
}

export interface EsLogTraceLinkResponse {
  traces: LinkedTraceSummary[];
  entities: Record<LogEntityKind, LogEntity[]>;
  linkedCount: number;
  unlinkedCount: number;
  missingTraceCount: number;
  failedTraceCount: number;
  skippedTraceCount: number;
}

export class LogSearchApi {
  constructor(private readonly bff: BffClient) {}

  sources(signal?: AbortSignal): Promise<EsLogSourceList> {
    return this.bff.request<EsLogSourceList>('GET', '/api/logs/sources', undefined, undefined, signal);
  }

  search(req: EsLogSearchRequest, signal?: AbortSignal): Promise<EsLogSearchResponse> {
    return this.bff.request<EsLogSearchResponse>('POST', '/api/logs/search', req, undefined, signal);
  }

  traceLink(req: EsLogTraceLinkRequest, signal?: AbortSignal): Promise<EsLogTraceLinkResponse> {
    return this.bff.request<EsLogTraceLinkResponse>('POST', '/api/logs/trace-link', req, undefined, signal);
  }
}
