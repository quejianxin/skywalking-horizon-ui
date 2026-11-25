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
 * 日志数据源的持久化与校验。
 *
 * 存储与 AI 设置同构：一个 0600 的 JSON 文件，只允许所有者访问，普通文件
 * （拒绝符号链接），原子替换写入。凭据字段只写不读——`view()` 只报告
 * `hasCredential`，任何管理接口都不回显明文。
 *
 * 未配置 `HORIZON_LOG_SOURCES_FILE` 时整块只读：列表为空，写接口返回 409。
 */

import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { z } from 'zod';
import { logger } from '../logger.js';
import type { LogSourceRecord, LogSourceView } from './types.js';

/** 一个 Elasticsearch 地址：http(s)、无 userinfo/query/fragment，去掉尾部斜杠。 */
export function normalizeLogSourceUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (!url.hostname) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** 索引模式：ES 索引名的字符集加 `*` / `,`；不允许前导 `*` 或 `_`。 */
const INDEX_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.*-]*$/;
export const MAX_LOG_SOURCES = 50;
export function isSafeIndexPattern(value: string): boolean {
  return value.split(',').every((pattern) => INDEX_PATTERN.test(pattern));
}

/** ES 字段名：字母数字、下划线、点、连字符和 `@`，不允许空白与控制字符。 */
const FIELD_PATTERN = /^[A-Za-z0-9_.@-]{1,200}$/;
function isSafeFieldName(value: string): boolean {
  return FIELD_PATTERN.test(value);
}

const fieldList = (fallback: readonly string[]) =>
  z.array(z.string().trim().min(1).max(200).refine(isSafeFieldName, '字段名只能包含字母、数字、下划线、点、连字符和 @'))
    .max(20)
    .default([...fallback]);

const sourceFields = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(100),
  url: z.string().trim().max(2000).refine(
    (value) => normalizeLogSourceUrl(value) !== undefined,
    '地址必须是无用户信息、查询参数和片段的 http(s) 地址',
  ),
  index: z.string().trim().min(1, '索引模式不能为空').max(500).refine(isSafeIndexPattern, '索引模式只能包含字母、数字、点、下划线、连字符、逗号和 *，且每项必须以字母或数字开头'),
  timeField: z.string().trim().min(1).max(200).refine(isSafeFieldName, '时间字段名不合法').default('@timestamp'),
  auth: z.enum(['none', 'basic', 'apiKey']).default('none'),
  username: z.string().trim().max(200).default(''),
  tlsVerify: z.boolean().default(true),
  defaultWindowMinutes: z.number().int().min(1).max(1440).default(30),
  maxRows: z.number().int().min(1).max(1000).default(200),
  traceIdFields: fieldList(['traceId', 'trace_id'] as const),
  messageFields: fieldList(['message', 'msg', 'content'] as const),
});

function validateAuth(
  value: z.infer<typeof sourceFields>,
  ctx: z.RefinementCtx,
): void {
  if (value.auth === 'basic' && value.username === '') {
    ctx.addIssue({ code: 'custom', path: ['username'], message: 'Basic 认证必须填写用户名' });
  }
}

export const logSourceInputSchema = sourceFields
  .extend({ credential: z.string().max(8192).nullable().optional() })
  .strict()
  .superRefine((value, ctx) => {
    validateAuth(value, ctx);
    if (!hasSafeTransport(value)) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: '发送认证凭据需要启用证书校验的 HTTPS 地址' });
    }
  });

export type LogSourceInput = z.infer<typeof logSourceInputSchema>;

const sourceFileSchema = sourceFields
  .extend({ id: z.string().uuid(), credential: z.string().max(8192) })
  .strict()
  .superRefine(validateAuth);

const storeFileSchema = z
  .object({
    version: z.literal(1).optional(),
    sources: z.array(sourceFileSchema).max(MAX_LOG_SOURCES),
  })
  .strict();

type StoreFile = z.infer<typeof storeFileSchema>;

export function hasSafeTransport(source: Pick<LogSourceRecord, 'url' | 'auth' | 'tlsVerify'>): boolean {
  return source.auth === 'none' || (source.tlsVerify && normalizeLogSourceUrl(source.url)?.startsWith('https://') === true);
}

export function parseLogSourceAllowlist(value: string): ReadonlySet<string> {
  return new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const url = normalizeLogSourceUrl(entry);
    if (!url) throw new Error('HORIZON_LOG_SOURCES_ALLOWED_BASE_URLS 含有不合法的基础地址');
    return url;
  }));
}

export class LogSourceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogSourceConfigurationError';
  }
}

export class LogSourceNotWritableError extends Error {
  constructor() {
    super('日志数据源文件未配置（HORIZON_LOG_SOURCES_FILE），当前为只读');
    this.name = 'LogSourceNotWritableError';
  }
}

export class LogSourceNotFoundError extends Error {
  constructor(id: string) {
    super(`日志数据源不存在：${id}`);
    this.name = 'LogSourceNotFoundError';
  }
}

class LogSourceFileModeError extends Error {
  constructor() {
    super('日志数据源文件必须为仅所有者可访问的普通文件');
  }
}

function toView(record: LogSourceRecord): LogSourceView {
  const { credential, ...rest } = record;
  return { ...rest, hasCredential: credential !== '' };
}

export interface LogSourceStoreDeps {
  /** 数据源文件绝对路径；空串表示禁用写接口。 */
  filePath: string;
  allowedBaseUrls?: ReadonlySet<string>;
}

export class LogSourceStore {
  private records: LogSourceRecord[];

  constructor(private readonly deps: LogSourceStoreDeps) {
    this.records = this.load();
  }

  get writable(): boolean {
    return this.deps.filePath !== '';
  }

  list(): LogSourceView[] {
    return this.records.map(toView);
  }

  /** 服务端内部使用；返回带凭据的完整记录。 */
  runtime(id: string): LogSourceRecord {
    const record = this.records.find((r) => r.id === id);
    if (!record) throw new LogSourceNotFoundError(id);
    const url = this.allowedUrl(record.url);
    this.assertSafeTransport(record);
    return { ...record, url };
  }

  create(input: LogSourceInput): LogSourceView {
    this.assertWritable();
    if (this.records.length >= MAX_LOG_SOURCES) {
      throw new LogSourceConfigurationError(`数据源数量不能超过 ${MAX_LOG_SOURCES}`);
    }
    const record: LogSourceRecord = {
      ...this.normalize(input),
      id: randomUUID(),
      credential: input.auth === 'none' ? '' : (input.credential ?? ''),
    };
    this.commit([...this.records, record]);
    return toView(record);
  }

  update(id: string, input: LogSourceInput): LogSourceView {
    this.assertWritable();
    const previous = this.records.find((r) => r.id === id);
    if (!previous) throw new LogSourceNotFoundError(id);
    const normalized = this.normalize(input);
    const sameTarget = previous.url === normalized.url && previous.auth === normalized.auth
      && previous.username === normalized.username && previous.tlsVerify === normalized.tlsVerify;
    const previousCredential = sameTarget ? previous.credential : '';
    const credential = input.auth === 'none' ? '' : (input.credential === undefined ? previousCredential : input.credential ?? '');
    const next: LogSourceRecord = { ...normalized, id, credential };
    this.commit(this.records.map((r) => (r.id === id ? next : r)));
    return toView(next);
  }

  remove(id: string): void {
    this.assertWritable();
    if (!this.records.some((r) => r.id === id)) throw new LogSourceNotFoundError(id);
    this.commit(this.records.filter((r) => r.id !== id));
  }

  private assertWritable(): void {
    if (!this.writable) throw new LogSourceNotWritableError();
  }

  private allowedUrl(value: string): string {
    const url = normalizeLogSourceUrl(value);
    if (!url || !this.deps.allowedBaseUrls?.has(url)) {
      throw new LogSourceConfigurationError('地址未列入部署配置 HORIZON_LOG_SOURCES_ALLOWED_BASE_URLS');
    }
    return url;
  }

  private assertSafeTransport(source: Pick<LogSourceRecord, 'url' | 'auth' | 'tlsVerify'>): void {
    if (!hasSafeTransport(source)) {
      throw new LogSourceConfigurationError('发送认证凭据需要启用证书校验的 HTTPS 地址');
    }
  }

  private normalize(input: LogSourceInput): Omit<LogSourceRecord, 'id' | 'credential'> {
    const url = this.allowedUrl(input.url);
    this.assertSafeTransport(input);
    return {
      name: input.name,
      url,
      index: input.index,
      timeField: input.timeField,
      auth: input.auth,
      username: input.auth === 'basic' ? input.username : '',
      tlsVerify: input.tlsVerify,
      defaultWindowMinutes: input.defaultWindowMinutes,
      maxRows: input.maxRows,
      traceIdFields: [...input.traceIdFields],
      messageFields: [...input.messageFields],
    };
  }

  private commit(next: LogSourceRecord[]): void {
    const parsed = storeFileSchema.safeParse({ version: 1, sources: next });
    if (!parsed.success) throw new LogSourceConfigurationError('日志数据源配置不合法');
    this.write(parsed.data);
    this.records = parsed.data.sources;
  }

  private load(): LogSourceRecord[] {
    if (!this.writable) return [];
    let raw: string;
    try {
      const fd = openSync(this.deps.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || (info.mode & 0o077) !== 0) throw new LogSourceFileModeError();
        raw = readFileSync(fd, 'utf8');
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      const error = err instanceof LogSourceFileModeError || code === 'ELOOP'
        ? new LogSourceFileModeError()
        : new Error('日志数据源文件读取失败');
      logger.error(`${error.message}，拒绝使用已有数据源`);
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.error('日志数据源文件不是合法 JSON，拒绝使用已有数据源');
      throw new Error('日志数据源文件不是合法 JSON');
    }
    const result = storeFileSchema.safeParse(parsed);
    if (!result.success) {
      logger.error('日志数据源文件字段不合法，拒绝使用已有数据源');
      throw new Error('日志数据源文件字段不合法');
    }
    return result.data.sources as LogSourceRecord[];
  }

  private write(next: StoreFile): void {
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
