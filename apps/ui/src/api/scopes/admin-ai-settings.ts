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

// AI 助手管理设置：读取生效配置、保存并立即生效。密钥只提交不回显。

import type { BffClient } from '../client';

export interface AiAdminSettings {
  enabled: boolean;
  provider: 'openai-compatible' | 'bedrock' | 'anthropic';
  model: string;
  baseUrl: string;
  region: string;
  hasApiKey: boolean;
  ready: boolean;
  /** false = 由 YAML / 环境变量接管，页面只读。 */
  writable: boolean;
  /** settings-file = 已保存；unset = 可写但尚未保存；environment = 只读环境配置。 */
  source: 'settings-file' | 'unset' | 'environment';
}

export interface AiAdminSettingsInput {
  enabled: boolean;
  provider: 'openai-compatible' | 'bedrock' | 'anthropic';
  model: string;
  baseUrl: string;
  region: string;
  /** 省略 = 保留现有密钥；空串 = 清除。 */
  apiKey?: string;
}

export class AdminAiSettingsApi {
  constructor(private readonly bff: BffClient) {}

  get(): Promise<AiAdminSettings> {
    return this.bff.request<AiAdminSettings>('GET', '/api/admin/ai-settings');
  }

  save(input: AiAdminSettingsInput): Promise<AiAdminSettings> {
    return this.bff.request<AiAdminSettings>('PUT', '/api/admin/ai-settings', input);
  }
}
