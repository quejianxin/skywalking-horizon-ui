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
 * 日志数据源与日志检索的共享类型。
 *
 * 指标、Trace、拓扑和告警仍由 OAP 提供；Elasticsearch 只作为日志的可选
 * 只读附加源。凭据只存在于服务端，管理接口用 `hasCredential` 报告是否已
 * 配置，视图类型里没有任何密钥字段。
 */

import type { NativeSpan } from '@skywalking-horizon-ui/api-client';

export type LogSourceAuth = 'none' | 'basic' | 'apiKey';

/** 持久化的一条数据源。`credential` 只写不读。 */
export interface LogSourceRecord {
  id: string;
  name: string;
  /** http(s) 基础地址；禁止 userinfo、query 和 fragment。 */
  url: string;
  /** 索引模式，可含 `*` 与 `,`。 */
  index: string;
  timeField: string;
  auth: LogSourceAuth;
  username: string;
  credential: string;
  tlsVerify: boolean;
  defaultWindowMinutes: number;
  maxRows: number;
  traceIdFields: string[];
  messageFields: string[];
}

/** 管理页读取的数据源视图；不含凭据明文。 */
export type LogSourceView = Omit<LogSourceRecord, 'credential'> & {
  hasCredential: boolean;
};

export interface LogSourceList {
  /** false = 未配置 HORIZON_LOG_SOURCES_FILE，页面只读。 */
  writable: boolean;
  sources: LogSourceView[];
}

/**
 * 检索页能看到的数据源摘要。
 *
 * 只给 `logs:read` 的账号没有 `log-source:read`，因此管理面那条列出完整视图的
 * 接口对他们不可见；检索页只需要挑一个数据源，拿不到地址、凭据、字段映射也
 * 无从发起查询，所以这里单独开一条最小列表。
 */
export interface LogSearchSource {
  id: string;
  name: string;
  index: string;
}

export interface LogSearchSourceList {
  sources: LogSearchSource[];
}

/** 检索请求；窗口与分页都有服务端上限。 */
export interface LogSearchRequest {
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

export interface LogSearchRow {
  /** ES `_id`，只在所属索引内唯一。 */
  id: string;
  /** 毫秒时间戳；时间字段缺失或不是数字时为 null。 */
  timestamp: number | null;
  /** 由数据源的 messageFields 依次取第一个非空字段。 */
  message: string;
  level: string | null;
  service: string | null;
  traceId: string | null;
  /** 原始 `_source`，供字段侧栏与展开行使用。 */
  fields: Record<string, unknown>;
}

export interface LogSearchResponse {
  generatedAt: number;
  source: { id: string; name: string; index: string };
  page: number;
  pageSize: number;
  hasNext: boolean;
  /** 命中总数；ES 可能只报告下界（track_total_hits 上限）。 */
  total: number;
  /** true = ES 在收集上限处提前结束，结果只是有界样本，不是全量前 N 条。 */
  truncated: boolean;
  tookMs: number;
  reachable: boolean;
  error?: string;
  logs: LogSearchRow[];
}

export type LogEntityKind = 'mq' | 'db' | 'rpc' | 'http';

/** 从 Span 汇总出的一个下游实体。 */
export interface LogEntity {
  kind: LogEntityKind;
  /** 展示名：组件名优先，其次 peer，再次 endpoint。 */
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

export const MAX_LOG_PAGE_SIZE = 1000;
const MAX_TRACE_ID_LENGTH = 256;

export function isLinkableTraceId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TRACE_ID_LENGTH && !/\s|\p{Cc}|\p{Cs}/u.test(value);
}

export type LinkSpan = Pick<NativeSpan,
  'serviceCode' | 'startTime' | 'endTime' | 'endpointName' | 'type' | 'peer' | 'component' | 'isError' | 'layer'>;

export interface LogTraceLinkResponse {
  traces: LinkedTraceSummary[];
  entities: Record<LogEntityKind, LogEntity[]>;
  /** 日志行计数，多个日志行可命中同一个 Trace。 */
  linkedCount: number;
  unlinkedCount: number;
  /** 不同 Trace ID 的计数，分别对应无记录、查询失败和超过上限。 */
  missingTraceCount: number;
  failedTraceCount: number;
  skippedTraceCount: number;
}
