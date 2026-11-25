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

import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { AiConfig } from '../config/schema.js';
import { aiEffectivelyReady } from './chat-assistant/provider/model.js';
import { logger } from '../logger.js';
import {
  AiConfigError,
  isApiKeyHeaderSafe,
  loadAiOutboundPolicy,
  normalizeModelBaseUrl,
  resolveModelTarget,
  type AiOutboundPolicy,
  type AiRuntimeConfig,
} from './model-outbound.js';

const settingsFields = z.object({
  enabled: z.boolean(),
  provider: z.enum(['openai-compatible', 'bedrock', 'anthropic']),
  model: z.string().trim().max(200),
  baseUrl: z.string().trim().max(2000).refine(
    (value) => value === '' || normalizeModelBaseUrl(value) !== undefined,
    'baseUrl 必须是无用户信息、查询参数和片段的 http(s) 地址',
  ),
  region: z.string().max(100),
});
const apiKeyField = z.string().max(8192).refine(isApiKeyHeaderSafe, 'apiKey 必须是可用于 HTTP Authorization 请求头的密钥');

function validateSettings(value: z.infer<typeof settingsFields>, ctx: z.RefinementCtx): void {
  if (value.enabled && value.model === '') {
    ctx.addIssue({ code: 'custom', path: ['model'], message: '启用 AI 助手时必须填写模型标识' });
  }
  if (value.enabled && value.provider === 'openai-compatible' && value.baseUrl === '') {
    ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'OpenAI 兼容服务必须填写 baseUrl' });
  }
}

const settingsFileSchema = settingsFields
  .extend({ version: z.literal(1).optional(), apiKey: apiKeyField })
  .strict()
  .superRefine(validateSettings);

type SettingsFile = z.infer<typeof settingsFileSchema>;

export const aiSettingsInputSchema = settingsFields
  .extend({ apiKey: apiKeyField.nullable().optional() })
  .strict()
  .superRefine(validateSettings);


export type AiSettingsInput = z.infer<typeof aiSettingsInputSchema>;

/** 管理页读取的视图；不含密钥明文，只报告是否已配置。 */
export interface AiSettingsView {
  enabled: boolean;
  provider: AiConfig['provider'];
  model: string;
  baseUrl: string;
  region: string;
  hasApiKey: boolean;
  ready: boolean;
  /** false = 未配置设置文件，配置由 YAML / 环境变量接管。 */
  writable: boolean;
  /** settings-file = 已有保存的文件；unset = 可写但尚未保存；environment = 只读环境配置。 */
  source: 'settings-file' | 'unset' | 'environment';
  /** 部署方批准的模型基础地址；空数组表示未放行任何地址。 */
  approvedBaseUrls: string[];
  /** 部署方批准的 Bedrock 区域。 */
  approvedRegions: string[];
}

export interface AiSettingsStoreDeps {
  /** 设置文件绝对路径；空串表示禁用管理页写入。 */
  filePath: string;
  /** YAML + 环境变量解析出的基础配置，每次读取以支持 horizon.yaml 热更新。 */
  base: () => AiConfig;
}

export class AiSettingsNotWritableError extends Error {
  constructor() {
    super('AI 设置文件未配置（HORIZON_AI_SETTINGS_FILE），当前配置由环境变量接管');
    this.name = 'AiSettingsNotWritableError';
  }
}

class AiSettingsFileModeError extends Error {
  constructor() {
    super('AI 设置文件必须为仅所有者可访问的普通文件');
  }
}

function visibleBaseUrl(value: string): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.username || url.password || url.search || url.hash ? '' : value;
  } catch {
    return '';
  }
}

export class AiSettingsStore {
  private overrides: SettingsFile | null;
  private readonly outboundPolicy?: AiOutboundPolicy;

  constructor(private readonly deps: AiSettingsStoreDeps) {
    if (this.writable) this.outboundPolicy = loadAiOutboundPolicy();
    this.overrides = this.load();
  }

  get writable(): boolean {
    return this.deps.filePath !== '';
  }

  /** 生效配置：设置文件字段优先，其余沿用基础配置。 */
  effective(): AiRuntimeConfig {
    const base = this.deps.base();
    if (!this.outboundPolicy) return base;
    const settings = this.overrides ?? { enabled: false, apiKey: '' };
    return { ...base, ...settings, outboundPolicy: this.outboundPolicy };
  }

  view(): AiSettingsView {
    const ai = this.effective();
    const approved = this.approvedOutbound();
    return {
      enabled: ai.enabled,
      provider: ai.provider,
      model: ai.model,
      baseUrl: visibleBaseUrl(ai.baseUrl),
      region: ai.region,
      hasApiKey: ai.apiKey !== '',
      ready: aiEffectivelyReady(ai),
      writable: this.writable,
      // 配置了设置文件即由该文件接管；文件尚未创建时环境配置也不会生效。
      source: this.overrides ? 'settings-file' : this.writable ? 'unset' : 'environment',
      approvedBaseUrls: approved.baseUrls,
      approvedRegions: approved.regions,
    };
  }

  /** 管理页展示的批准名单，只读且不含密钥。 */
  private approvedOutbound(): { baseUrls: string[]; regions: string[] } {
    const policy = this.outboundPolicy;
    return {
      baseUrls: policy ? [...policy.baseUrls].sort() : [],
      regions: policy ? [...policy.regions].sort() : [],
    };
  }

  save(input: AiSettingsInput): AiSettingsView {
    const outboundPolicy = this.outboundPolicy;
    if (!outboundPolicy) throw new AiSettingsNotWritableError();
    const target = resolveModelTarget({ ...input, outboundPolicy }, input.enabled);
    const previous = this.overrides;
    const sameTarget = previous?.provider === input.provider
      && previous.baseUrl === target.baseUrl && previous.region === target.region;
    // 比较解析后的目标，避免 AWS 区域回退值变动时复用旧密钥。
    const apiKey = input.apiKey ?? (sameTarget ? previous.apiKey : '');
    if (!isApiKeyHeaderSafe(apiKey)) {
      throw new AiConfigError('apiKey', 'apiKey 必须是可用于 HTTP Authorization 请求头的密钥');
    }
    const next: SettingsFile = {
      version: 1,
      enabled: input.enabled,
      provider: input.provider,
      model: input.model,
      ...target,
      apiKey,
    };
    this.write(next);
    this.overrides = next;
    return this.view();
  }

  private load(): SettingsFile | null {
    const outboundPolicy = this.outboundPolicy;
    if (!outboundPolicy) return null;
    let raw: string;
    try {
      const fd = openSync(this.deps.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || (info.mode & 0o077) !== 0) {
          throw new AiSettingsFileModeError();
        }
        raw = readFileSync(fd, 'utf8');
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      const error = err instanceof AiSettingsFileModeError || code === 'ELOOP'
        ? new AiSettingsFileModeError()
        : new Error('AI 设置文件读取失败');
      logger.error(`${error.message}，拒绝使用基础配置`);
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.error('AI 设置文件不是合法 JSON，拒绝使用基础配置');
      throw new Error('AI 设置文件不是合法 JSON');
    }
    const result = settingsFileSchema.safeParse(parsed);
    if (!result.success) {
      logger.error('AI 设置文件字段不合法，拒绝使用基础配置');
      throw new Error('AI 设置文件字段不合法');
    }
    try {
      const target = resolveModelTarget({ ...result.data, outboundPolicy }, result.data.enabled);
      return { ...result.data, ...target };
    } catch (err) {
      if (err instanceof AiConfigError) logger.error(`AI 设置文件未通过目标校验：${err.message}`);
      throw err;
    }
  }

  private write(next: SettingsFile): void {
    const path = this.deps.filePath;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      try {
        writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // 临时文件可能尚未创建，忽略清理失败。
      }
      throw err;
    }
  }
}
