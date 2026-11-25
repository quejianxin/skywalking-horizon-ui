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
 * Elasticsearch 只读客户端。
 *
 * 只实现 `_search` 与 `_cluster/health`。写入、脚本、删除和任何管理接口
 * 都不存在于此，因此路由层即使被直接调用也拿不到写能力。`_msearch` 只有
 * 在多数据源聚合真正需要时才加，不做预留。
 *
 * 凭据只在服务端拼进请求头；本模块返回的任何对象都不含凭据。
 */

import { Buffer } from 'node:buffer';
import { request as httpsRequest } from 'node:https';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { hasSafeTransport } from '../logs/sources.js';
import type { LogSourceAuth } from '../logs/types.js';

export interface EsSourceRuntime {
  url: string;
  index: string;
  auth: LogSourceAuth;
  username: string;
  credential: string;
  tlsVerify: boolean;
}

export interface EsRequestOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class EsHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'EsHttpError';
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** 索引模式只经过一次编码；`*`、`,`、`-`、`.` 必须原样到达 ES。 */
function encodeIndex(index: string): string {
  return encodeURIComponent(index).replace(/%2C/gi, ',');
}

function authHeader(source: EsSourceRuntime): Record<string, string> {
  if (source.auth === 'basic') {
    const token = Buffer.from(`${source.username}:${source.credential}`, 'utf8').toString('base64');
    return { authorization: `Basic ${token}` };
  }
  if (source.auth === 'apiKey') return { authorization: `ApiKey ${source.credential}` };
  return {};
}

interface RawResponse {
  status: number;
  body: string;
}

/**
 * TLS 校验关闭时 Node 的 fetch 无法表达 `rejectUnauthorized: false`，因此
 * 只有这一条分支走 `node:https`。校验开启（默认）时一律走 fetch，方便测试
 * 注入。Elasticsearch 凭据和日志内容不进入 OAP 的 wire 日志。
 */
function insecureRequest(
  target: URL,
  path: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || 443,
        path,
        method,
        headers: { ...headers, ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}) },
        rejectUnauthorized: false,
        timeout: timeoutMs,
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new EsHttpError(0, 'Elasticsearch 响应超过 8 MB 上限'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Elasticsearch 请求超时')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function readBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size).toString('utf8');
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new EsHttpError(response.status, 'Elasticsearch 响应超过 8 MB 上限');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function rawRequest(
  source: EsSourceRuntime,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  opts: EsRequestOptions,
): Promise<RawResponse> {
  if (!hasSafeTransport(source)) throw new EsHttpError(0, '发送认证凭据需要启用证书校验的 HTTPS 地址');
  const base = new URL(source.url);
  const headers = {
    accept: 'application/json',
    ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...authHeader(source),
  };
  const payload = init.body !== undefined ? JSON.stringify(init.body) : undefined;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fullPath = `${base.pathname.replace(/\/+$/, '')}${path}`;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  signal.throwIfAborted();
  if (!source.tlsVerify && base.protocol === 'https:') {
    return insecureRequest(base, fullPath, init.method, headers, payload, signal, timeoutMs);
  }
  const fetch = opts.fetch ?? globalThis.fetch;
  const response = await fetch(`${base.origin}${fullPath}`, {
    method: init.method, headers, body: payload, signal, redirect: 'manual',
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, body: '' };
  }
  return { status: response.status, body: await readBody(response) };
}

async function esJson<T>(
  source: EsSourceRuntime,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  opts: EsRequestOptions,
): Promise<T> {
  let raw: RawResponse;
  try {
    raw = await rawRequest(source, path, init, opts);
  } catch (err) {
    opts.signal?.throwIfAborted();
    if (err instanceof EsHttpError) throw err;
    throw new EsHttpError(0, 'Elasticsearch 不可达，请检查网络、证书和连接超时');
  }
  if (raw.status >= 300 && raw.status < 400) {
    throw new EsHttpError(raw.status, 'Elasticsearch 返回重定向，请配置最终地址');
  }
  if (raw.status < 200 || raw.status >= 300) {
    throw new EsHttpError(raw.status, `Elasticsearch 返回 HTTP ${raw.status}，请检查索引和查询权限`);
  }
  try {
    return JSON.parse(raw.body) as T;
  } catch {
    throw new EsHttpError(raw.status, 'Elasticsearch 返回的不是合法 JSON');
  }
}

export interface EsSearchResponse {
  took: number;
  timed_out: boolean;
  hits: {
    total: number | { value: number; relation: 'eq' | 'gte' };
    hits: Array<{ _id: string; _source?: Record<string, unknown>; sort?: unknown[] }>;
  };
  terminated_early?: boolean;
  _shards?: { failed?: number };
}

export interface EsClusterHealth {
  cluster_name?: string;
  status?: string;
  number_of_nodes?: number;
  timed_out?: boolean;
}

function searchPath(source: EsSourceRuntime): string {
  return `/${encodeIndex(source.index)}/_search`;
}

/** 只读检索；DSL 由 `logs/query.ts` 生成，调用方不得自行拼接。 */
export async function esSearch(
  source: EsSourceRuntime,
  body: Record<string, unknown>,
  opts: EsRequestOptions = {},
): Promise<EsSearchResponse> {
  const result = await esJson<EsSearchResponse>(source, searchPath(source), { method: 'POST', body }, opts);
  if (!Array.isArray(result?.hits?.hits)) throw new EsHttpError(200, 'Elasticsearch 返回的不是合法检索结果');
  if (result.timed_out || (result._shards?.failed ?? 0) > 0) {
    throw new EsHttpError(200, 'Elasticsearch 查询超时或分片失败，未返回完整结果');
  }
  return result;
}

export function esClusterHealth(
  source: EsSourceRuntime,
  opts: EsRequestOptions = {},
): Promise<EsClusterHealth> {
  return esJson<EsClusterHealth>(source, '/_cluster/health', { method: 'GET' }, opts);
}

/** 连接测试的最小检索：只要一条文档，不取 `_source`。 */
export function esProbe(
  source: EsSourceRuntime,
  opts: EsRequestOptions = {},
): Promise<EsSearchResponse> {
  return esSearch(source, { size: 1, track_total_hits: false, _source: false, query: { match_all: {} } }, opts);
}
