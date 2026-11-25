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

// 诊断服务：Trace 详情里的规则结论、SQL 聚合、锁等待、异步与线程归因。

import type { BffClient } from '../client';

export interface DiagnosisFinding {
  ruleId: string;
  severity: string;
  title: string;
  detail: string;
  evidence: string[];
}

export interface DiagnosisRuleReport {
  traceId: string;
  modelAvailable: boolean;
  modelNote: string;
  findings: DiagnosisFinding[];
}

export interface DiagnosisSummary {
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

export interface DiagnosisSqlSample {
  statement: string;
  durationMs: number;
  serviceCode: string;
}

export interface DiagnosisSqlAggregate {
  template: string;
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  samples: DiagnosisSqlSample[];
}

export interface DiagnosisSql {
  traceId: string;
  traceMissing: boolean;
  aggregates: DiagnosisSqlAggregate[];
}

export interface DiagnosisLockWait {
  sessionId: string | null;
  lockType: string | null;
  waitMs: number;
  verified: boolean;
  note: string;
}

export interface DiagnosisLocks {
  traceId: string;
  traceMissing: boolean;
  waits: DiagnosisLockWait[];
}

export interface DiagnosisAsyncPhase {
  serviceCode: string;
  endpointName: string;
  enqueueMs: number;
  queueWaitMs: number;
  executeMs: number;
  verified: boolean;
  note: string;
}

export interface DiagnosisAsync {
  traceId: string;
  traceMissing: boolean;
  phases: DiagnosisAsyncPhase[];
}

export interface DiagnosisThreadGroup {
  serviceInstance: string;
  threadKey: string;
  threadName: string;
  spanCount: number;
  totalMs: number;
  maxMs: number;
}

export interface DiagnosisThreads {
  traceId: string;
  traceMissing: boolean;
  threads: DiagnosisThreadGroup[];
}

export interface DiagnosisTraceBundle {
  traceId: string;
  traceMissing: boolean;
  summary: DiagnosisSummary;
  ruleReport: DiagnosisRuleReport;
  sql: DiagnosisSql;
  locks: DiagnosisLocks;
  async: DiagnosisAsync;
  threads: DiagnosisThreads;
}

export class DiagnosisApi {
  constructor(private readonly bff: BffClient) {}

  status(): Promise<{ enabled: boolean }> {
    return this.bff.request<{ enabled: boolean }>('GET', '/api/diagnosis/status');
  }

  trace(traceId: string): Promise<DiagnosisTraceBundle> {
    return this.bff.request<DiagnosisTraceBundle>(
      'GET',
      `/api/diagnosis/traces/${encodeURIComponent(traceId)}`,
    );
  }
}
