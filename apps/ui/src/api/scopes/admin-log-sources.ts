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

// 日志数据源管理：列出、新增、修改、删除，以及连接测试。
// 凭据只提交不回显——视图里只有 `hasCredential`。

import type { BffClient } from '../client';

export type LogSourceAuth = 'none' | 'basic' | 'apiKey';

/** 管理页读取的一条数据源；不含凭据明文。 */
export interface LogSourceView {
  id: string;
  name: string;
  url: string;
  index: string;
  timeField: string;
  auth: LogSourceAuth;
  username: string;
  tlsVerify: boolean;
  defaultWindowMinutes: number;
  maxRows: number;
  traceIdFields: string[];
  messageFields: string[];
  hasCredential: boolean;
}

export interface LogSourceList {
  /** false = 部署未配置数据源文件，页面只读。 */
  writable: boolean;
  sources: LogSourceView[];
}

export interface LogSourceInput {
  name: string;
  url: string;
  index: string;
  timeField: string;
  auth: LogSourceAuth;
  username: string;
  /** 省略 = 保留现有凭据（仅当地址、认证方式与用户名都没变）；空串 = 清除。 */
  credential?: string;
  tlsVerify: boolean;
  defaultWindowMinutes: number;
  maxRows: number;
  traceIdFields: string[];
  messageFields: string[];
}

/** 连接测试成功的结果；失败由接口以 502 返回。 */
export interface LogSourceTestResult {
  ok: true;
  elapsedMs: number;
  cluster: string | null;
  status: string | null;
  nodes: number | null;
  sampled: number;
}

export class AdminLogSourcesApi {
  constructor(private readonly bff: BffClient) {}

  list(): Promise<LogSourceList> {
    return this.bff.request<LogSourceList>('GET', '/api/admin/log-sources');
  }

  create(input: LogSourceInput): Promise<LogSourceView> {
    return this.bff.request<LogSourceView>('POST', '/api/admin/log-sources', input);
  }

  update(id: string, input: LogSourceInput): Promise<LogSourceView> {
    return this.bff.request<LogSourceView>(
      'PUT',
      `/api/admin/log-sources/${encodeURIComponent(id)}`,
      input,
    );
  }

  remove(id: string): Promise<void> {
    return this.bff.request<void>(
      'DELETE',
      `/api/admin/log-sources/${encodeURIComponent(id)}`,
    );
  }

  test(id: string): Promise<LogSourceTestResult> {
    return this.bff.request<LogSourceTestResult>(
      'POST',
      `/api/admin/log-sources/${encodeURIComponent(id)}/test`,
    );
  }
}
