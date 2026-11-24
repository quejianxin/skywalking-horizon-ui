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
 * Pluggable LLM provider — the ONE place a chat model is constructed. Keeps
 * the agent + tools vendor-neutral: they see a `BaseChatModel` and never know
 * which backend answered. Three providers today: any OpenAI-compatible endpoint
 * (default, via baseUrl), Amazon Bedrock Converse, and the Anthropic Claude
 * Messages API (baseUrl only when pointed at a gateway).
 *
 * Credentials are resolved per request (never module-global) — the Bedrock
 * bearer key is passed to the constructor explicitly rather than via
 * `AWS_BEARER_TOKEN_BEDROCK`, so concurrent requests don't race a shared env.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatBedrockConverse } from '@langchain/aws';
import { ChatOpenAI } from '@langchain/openai';
import {
  AiConfigError,
  isApiKeyHeaderSafe,
  resolveModelTarget,
  type AiOutboundPolicy,
  type AiRuntimeConfig,
} from '../../model-outbound.js';

export { AiConfigError } from '../../model-outbound.js';
export type AiProvider = AiRuntimeConfig['provider'];

const ANTHROPIC_DEFAULT_URL = 'https://api.anthropic.com';

/** Resolved, ready-to-use credentials for ONE chat request, assembled from the
 *  central `config.ai` — the factory only ever sees this normalized shape. */
export interface AiCredentials {
  provider: AiProvider;
  model: string;
  apiKey: string;
  /** OpenAI-compatible base URL, or an Anthropic gateway URL. */
  baseUrl?: string;
  /** AWS 区域；留空时按部署环境解析。 */
  region?: string;
  readonly outboundPolicy?: AiOutboundPolicy;
}

function validateCredentials(creds: AiCredentials): ReturnType<typeof resolveModelTarget> {
  if (!creds.model.trim()) throw new AiConfigError('model', 'ai.model is not set');
  if (!creds.apiKey || !isApiKeyHeaderSafe(creds.apiKey)) {
    throw new AiConfigError('apiKey', 'ai.apiKey 必须是可用于 HTTP Authorization 请求头的非空密钥');
  }
  return resolveModelTarget(creds, true);
}

/** 就绪状态与实际构建模型使用同一套凭证和目标约束，不探测网络。 */
export function centralCredentialsComplete(ai: AiRuntimeConfig): boolean {
  try {
    validateCredentials(resolveCredentials(ai));
    return true;
  } catch (err) {
    if (err instanceof AiConfigError) return false;
    throw err;
  }
}

export function aiEffectivelyReady(ai: AiRuntimeConfig): boolean {
  return ai.enabled && centralCredentialsComplete(ai);
}

export function resolveCredentials(ai: AiRuntimeConfig): AiCredentials {
  return {
    provider: ai.provider,
    model: ai.model,
    apiKey: ai.apiKey,
    baseUrl: ai.baseUrl || undefined,
    region: ai.region || undefined,
    outboundPolicy: ai.outboundPolicy,
  };
}

/** Construct the streaming chat model for the resolved credentials. Streaming
 *  is always on (the SSE route consumes token deltas); temperature is fixed at
 *  0 for tool-calling determinism. Output-token caps are left to the gateway /
 *  provider. Throws `AiConfigError` on any missing provider-required field. */
export function buildChatModel(creds: AiCredentials): BaseChatModel {
  const { provider, model, apiKey } = creds;
  const { baseUrl, region } = validateCredentials(creds);

  if (provider === 'bedrock') {
    return new ChatBedrockConverse({
      model,
      region,
      bedrockBearerToken: apiKey,
      // 可写模式只能使用获批区域的 AWS 端点，不采用 SDK 的环境变量或共享配置端点覆盖。
      clientOptions: creds.outboundPolicy ? { ignoreConfiguredEndpointUrls: true } : undefined,
      temperature: 0,
      streaming: true,
    });
  }

  if (provider === 'anthropic') {
    return new ChatAnthropic({
      model,
      apiKey,
      // 可写模式固定官方端点，避免 ANTHROPIC_BASE_URL 把流量导到未获批地址；
      // 填写地址时已由 resolveModelTarget 校验过名单。
      anthropicApiUrl: baseUrl || (creds.outboundPolicy ? ANTHROPIC_DEFAULT_URL : undefined),
      temperature: 0,
      streaming: true,
      clientOptions: {
        fetch: (input, init) => globalThis.fetch(input, { ...init, redirect: 'error' }),
      },
    });
  }

  return new ChatOpenAI({
    model,
    apiKey,
    temperature: 0,
    streaming: true,
    configuration: {
      baseURL: baseUrl,
      // 在 SDK 合并请求选项后关闭重定向，连同源跳转也不跟随。
      fetch: (input, init) => globalThis.fetch(input, { ...init, redirect: 'error' }),
    },
    // Routing hint for OpenAI-compatible prompt caching: a stable key keeps our
    // shared static prefix (system prompt + tool schemas) on the same cache pool
    // across requests. Caching itself is automatic server-side (OpenAI /
    // DeepSeek API); this just improves the hit rate. No-op on endpoints that
    // ignore it.
    promptCacheKey: 'skywalking-horizon-ai',
  });
}
