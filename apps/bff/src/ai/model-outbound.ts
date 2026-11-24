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

import type { AiConfig } from '../config/schema.js';

const ALLOWED_BASE_URLS_ENV = 'HORIZON_AI_ALLOWED_BASE_URLS';
const ALLOWED_REGIONS_ENV = 'HORIZON_AI_ALLOWED_BEDROCK_REGIONS';
const BEDROCK_REGION_PATTERN = /^[a-z]{2,4}(?:-[a-z]+){1,3}-[1-9][0-9]*$/;
const MAX_REGION_LENGTH = 63;

export interface AiOutboundPolicy {
  readonly baseUrls: ReadonlySet<string>;
  readonly regions: ReadonlySet<string>;
}

export type AiRuntimeConfig = AiConfig & { readonly outboundPolicy?: AiOutboundPolicy };

interface AiModelTarget {
  readonly provider: AiConfig['provider'];
  readonly baseUrl?: string;
  readonly region?: string;
  readonly outboundPolicy?: AiOutboundPolicy;
}

export class AiConfigError extends Error {
  constructor(readonly field: 'baseUrl' | 'region' | 'model' | 'apiKey', message: string) {
    super(message);
    this.name = 'AiConfigError';
  }
}

export function isApiKeyHeaderSafe(value: string): boolean {
  return !/[^\x21-\x7e]/.test(value);
}

export function normalizeModelBaseUrl(raw: string): string | undefined {
  // 空的 userinfo、查询或片段也不允许；URL 属性不会保留所有空分隔符。
  const authority = /^https?:\/\/([^/]+)/i.exec(raw)?.[1];
  if (!authority || authority.includes('@') || /[\s\\?#*]/u.test(raw)) return undefined;
  try {
    return new URL(raw).href.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

function isBedrockRegion(value: string): boolean {
  return value.length <= MAX_REGION_LENGTH && BEDROCK_REGION_PATTERN.test(value);
}

function approvedValues(envName: string, normalize: (value: string) => string | undefined): ReadonlySet<string> {
  const raw = process.env[envName]?.trim();
  if (!raw) return new Set();
  const values = raw.split(',').map((entry) => {
    const value = normalize(entry.trim());
    if (!value) throw new Error(`${envName} 含无效条目`);
    return value;
  });
  return new Set(values);
}

/** 审批来自进程环境，设置文件与管理页均不能改变名单。 */
export function loadAiOutboundPolicy(): AiOutboundPolicy {
  return {
    baseUrls: approvedValues(ALLOWED_BASE_URLS_ENV, normalizeModelBaseUrl),
    regions: approvedValues(ALLOWED_REGIONS_ENV, (region) => isBedrockRegion(region) ? region : undefined),
  };
}

function resolveBaseUrl(target: AiModelTarget, isRequired: boolean): string | undefined {
  const raw = target.baseUrl || undefined;
  if (!raw && isRequired && target.provider === 'openai-compatible') {
    throw new AiConfigError('baseUrl', 'OpenAI 兼容服务必须填写 baseUrl');
  }
  if (!raw || !target.outboundPolicy) return raw;
  const baseUrl = normalizeModelBaseUrl(raw);
  if (!baseUrl) {
    throw new AiConfigError('baseUrl', 'baseUrl 必须是无用户信息、查询参数和片段的 http(s) 地址');
  }
  if (!target.outboundPolicy.baseUrls.has(baseUrl)) {
    throw new AiConfigError('baseUrl', `baseUrl 未获部署方批准，请检查 ${ALLOWED_BASE_URLS_ENV}`);
  }
  return baseUrl;
}

function resolveRegion(target: AiModelTarget, isRequired: boolean): string | undefined {
  const isBedrock = target.provider === 'bedrock';
  const fallback = isBedrock ? process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION : undefined;
  const region = target.region || fallback || undefined;
  if (!region && isRequired && isBedrock) {
    throw new AiConfigError('region', 'Bedrock 必须填写 region 或设置 AWS_REGION / AWS_DEFAULT_REGION');
  }
  if (!region || (!isBedrock && !target.outboundPolicy)) return region;
  if (!isBedrockRegion(region)) throw new AiConfigError('region', 'region 必须是有效的 AWS 区域格式');
  if (target.outboundPolicy && !target.outboundPolicy.regions.has(region)) {
    throw new AiConfigError('region', `region 未获部署方批准，请检查 ${ALLOWED_REGIONS_ENV}`);
  }
  return region;
}

/** 保存、恢复、就绪检查和模型构造均使用相同的目标解析。 */
export function resolveModelTarget(target: AiModelTarget, isRequired: boolean): Pick<AiConfig, 'baseUrl' | 'region'> {
  return { baseUrl: resolveBaseUrl(target, isRequired) ?? '', region: resolveRegion(target, isRequired) ?? '' };
}
