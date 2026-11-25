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
 * 诊断服务客户端。
 *
 * 诊断服务只读 OAP 的 Trace，产出 OAP 协议之外的推断：规则结论、SQL 模板
 * 聚合、锁等待、异步时段与线程归因。Trace 瀑布、日志、拓扑和告警仍由
 * SkyWalking 原生页面提供；这里只把「Trace 打开后还缺的那一步」补上。
 *
 * 六个只读接口一次并发读取，合成一个响应给页面，避免页面逐块闪烁。
 * 令牌只在服务端使用，绝不返回浏览器。
 */

import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { wireFetch } from './wire-log.js';

export interface DiagConfig {
  url: string;
  token: string;
  timeoutMs: number;
}

export interface DiagFinding {
  ruleId: string;
  severity: string;
  title: string;
  detail: string;
  evidence: string[];
}

export interface DiagRuleReport {
  traceId: string;
  modelAvailable: boolean;
  modelNote: string;
  findings: DiagFinding[];
}

export interface DiagSummary {
  traceId: string;
  traceMissing: boolean;
  note: string | null;
  entryCount: number;
  databaseCount: number;
  inferredCount: number;
  /** 早期诊断服务不返回这两个计数；面板按锁等待与异步分段本身计数。 */
  lockWaitCount?: number;
  asyncCount?: number;
}

export interface DiagSqlSample {
  statement: string;
  durationMs: number;
  serviceCode: string;
}

export interface DiagSqlAggregate {
  template: string;
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  samples: DiagSqlSample[];
}

export interface DiagSqlResponse {
  traceId: string;
  traceMissing: boolean;
  aggregates: DiagSqlAggregate[];
}

export interface DiagLockWait {
  sessionId: string | null;
  lockType: string | null;
  waitMs: number;
  verified: boolean;
  note: string;
}

export interface DiagLocksResponse {
  traceId: string;
  traceMissing: boolean;
  waits: DiagLockWait[];
}

export interface DiagAsyncPhase {
  serviceCode: string;
  endpointName: string;
  enqueueMs: number;
  queueWaitMs: number;
  executeMs: number;
  verified: boolean;
  note: string;
}

export interface DiagAsyncResponse {
  traceId: string;
  traceMissing: boolean;
  phases: DiagAsyncPhase[];
}

export interface DiagThreadGroup {
  serviceInstance: string;
  threadKey: string;
  threadName: string;
  spanCount: number;
  totalMs: number;
  maxMs: number;
}

export interface DiagThreadsResponse {
  traceId: string;
  traceMissing: boolean;
  threads: DiagThreadGroup[];
}

/** 一个 Trace 的完整诊断结果。`traceMissing` 为真时各段可能只有说明文本。 */
export interface DiagTraceBundle {
  traceId: string;
  traceMissing: boolean;
  summary: DiagSummary;
  ruleReport: DiagRuleReport;
  sql: DiagSqlResponse;
  locks: DiagLocksResponse;
  async: DiagAsyncResponse;
  threads: DiagThreadsResponse;
}

export class DiagnosisHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, message: string, body = '') {
    super(message);
    this.name = 'DiagnosisHttpError';
    this.status = status;
    this.body = body;
  }
}

/** Trace id 会进入 URL 路径；只放行诊断服务能接受的字符，避免路径注入。
 *  至少要有字母或数字：`.`, `..` 这类纯点 id 会被 URL 规范化成上一级目录。 */
const TRACE_ID_PATTERN = /^(?=.*[A-Za-z0-9])[A-Za-z0-9._:-]{1,128}$/;

export function isDiagnosisConfigured(cfg: DiagConfig): boolean {
  return cfg.url.trim() !== '';
}

export function isValidDiagnosisTraceId(traceId: string): boolean {
  return TRACE_ID_PATTERN.test(traceId);
}

async function diagFetch<T>(
  cfg: DiagConfig,
  path: string,
  fetch: FetchLike,
  signal?: AbortSignal,
): Promise<T> {
  const url = cfg.url.replace(/\/$/, '') + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  // 与 client/traceql.ts 一致：调用方的取消不覆盖本客户端自己的超时。
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: combined });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new DiagnosisHttpError(res.status, `diagnosis ${res.status} ${path} — ${body.slice(0, 200)}`, body.trim());
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof DiagnosisHttpError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new DiagnosisHttpError(0, `诊断服务不可达（${cfg.url}）：${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 一次读取诊断服务给一个 Trace 的全部结论。六个接口并发，任何一个失败都
 * 让整个请求失败——半份诊断会被误读成「没有锁等待」，比明确报错更危险。
 */
export async function readTraceDiagnosis(
  cfg: DiagConfig,
  traceId: string,
  opts: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<DiagTraceBundle> {
  const f = wireFetch(opts.fetch ?? globalThis.fetch.bind(globalThis));
  const base = `/diagnosis/traces/${encodeURIComponent(traceId)}`;
  const [summary, ruleReport, sql, locks, async, threads] = await Promise.all([
    diagFetch<DiagSummary>(cfg, `${base}/summary`, f, opts.signal),
    diagFetch<DiagRuleReport>(cfg, `${base}/rule-report`, f, opts.signal),
    diagFetch<DiagSqlResponse>(cfg, `${base}/sql?samples=5`, f, opts.signal),
    diagFetch<DiagLocksResponse>(cfg, `${base}/locks`, f, opts.signal),
    diagFetch<DiagAsyncResponse>(cfg, `${base}/async`, f, opts.signal),
    diagFetch<DiagThreadsResponse>(cfg, `${base}/threads`, f, opts.signal),
  ]);
  return {
    traceId,
    traceMissing: summary.traceMissing,
    summary,
    ruleReport,
    sql,
    locks,
    async,
    threads,
  };
}
