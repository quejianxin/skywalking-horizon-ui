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

import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isSafeIndexPattern,
  logSourceInputSchema,
  LogSourceConfigurationError,
  LogSourceNotFoundError,
  LogSourceNotWritableError,
  LogSourceStore,
  normalizeLogSourceUrl,
  parseLogSourceAllowlist,
  MAX_LOG_SOURCES,
} from './sources.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'horizon-log-sources-test-'));
  directories.push(directory);
  return join(directory, 'log-sources.json');
}

const allowedBaseUrls = parseLogSourceAllowlist('https://es.example.test:9200/,https://other.example.test:9200');
const input = {
  name: 'prod-es',
  url: 'https://es.example.test:9200/',
  index: 'app-logs-*',
  auth: 'basic', username: 'reader', credential: 'invented-test-credential',
};

describe('日志数据源校验', () => {
  it('地址只接受无用户信息、查询与片段的 http(s)', () => {
    expect(normalizeLogSourceUrl('https://es.example.test:9200/')).toBe('https://es.example.test:9200');
    expect(normalizeLogSourceUrl('http://es.example.test/base/')).toBe('http://es.example.test/base');
    expect(normalizeLogSourceUrl('https://user:pass@es.example.test')).toBeUndefined();
    expect(normalizeLogSourceUrl('https://es.example.test/?x=1')).toBeUndefined();
    expect(normalizeLogSourceUrl('ftp://es.example.test')).toBeUndefined();
    expect(normalizeLogSourceUrl('not a url')).toBeUndefined();
  });

  it('索引模式禁止前导 * 与 _', () => {
    expect(isSafeIndexPattern('app-logs-*')).toBe(true);
    expect(isSafeIndexPattern('a,b')).toBe(true);
    expect(isSafeIndexPattern('*logs')).toBe(false);
    expect(isSafeIndexPattern('_hidden')).toBe(false);
    expect(isSafeIndexPattern('app-logs-*,*')).toBe(false);
    expect(isSafeIndexPattern('logs/../secret')).toBe(false);
  });

  it('Basic 认证必须带用户名', () => {
    expect(logSourceInputSchema.safeParse({ ...input, username: '' }).success).toBe(false);
    expect(logSourceInputSchema.safeParse({ ...input, auth: 'basic', username: 'reader' }).success).toBe(true);
  });
});

describe('LogSourceStore', () => {
  it('未配置文件时只读，写操作抛 NotWritable', () => {
    const store = new LogSourceStore({ filePath: '' });
    expect(store.writable).toBe(false);
    expect(store.list()).toEqual([]);
    expect(() => store.create(logSourceInputSchema.parse(input))).toThrow(LogSourceNotWritableError);
  });

  it('写入 0600 文件，视图不含凭据明文', () => {
    const filePath = tempFile();
    const store = new LogSourceStore({ filePath, allowedBaseUrls });
    const view = store.create(logSourceInputSchema.parse(input));
    expect(view.hasCredential).toBe(true);
    expect(JSON.stringify(view)).not.toContain(input.credential);
    expect((statSync(filePath).mode & 0o777).toString(8)).toBe('600');
    expect(JSON.parse(readFileSync(filePath, 'utf8')).sources[0].credential).toBe(input.credential);
  });

  it('同目标省略凭据时保留原值，换目标则清空', () => {
    const filePath = tempFile();
    const store = new LogSourceStore({ filePath, allowedBaseUrls });
    const created = store.create(logSourceInputSchema.parse({ ...input, auth: 'basic', username: 'reader' }));
    // 第二次提交不带 credential：同目标视为「沿用」，换地址视为「旧凭据无效」。
    const same = store.update(created.id, logSourceInputSchema.parse({
      name: 'renamed', url: input.url, index: input.index, auth: 'basic', username: 'reader',
    }));
    expect(same.hasCredential).toBe(true);
    expect(store.runtime(created.id).credential).toBe(input.credential);

    const moved = store.update(created.id, logSourceInputSchema.parse({
      name: 'renamed', url: 'https://other.example.test:9200', index: input.index, auth: 'basic', username: 'reader',
    }));
    expect(moved.hasCredential).toBe(false);
    expect(store.runtime(created.id).credential).toBe('');
  });

  it('重启后从文件恢复，未知 id 抛 NotFound', () => {
    const filePath = tempFile();
    const created = new LogSourceStore({ filePath, allowedBaseUrls }).create(logSourceInputSchema.parse(input));
    const reloaded = new LogSourceStore({ filePath, allowedBaseUrls });
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.runtime(created.id).credential).toBe(input.credential);
    expect(() => reloaded.runtime('7d1f4b0e-0000-4000-8000-000000000000')).toThrow(LogSourceNotFoundError);
  });

  it('拒绝不是仅所有者可访问的文件', () => {
    const filePath = tempFile();
    new LogSourceStore({ filePath, allowedBaseUrls }).create(logSourceInputSchema.parse(input));
    chmodSync(filePath, 0o644);
    expect(() => new LogSourceStore({ filePath, allowedBaseUrls })).toThrow('仅所有者可访问');
  });

  it('精确限制端点，并在端点撤销后拒绝读取已有记录', () => {
    const filePath = tempFile();
    const store = new LogSourceStore({ filePath, allowedBaseUrls });
    const created = store.create(logSourceInputSchema.parse(input));
    expect(() => store.create(logSourceInputSchema.parse({ ...input, url: `${input.url}other` }))).toThrow();
    const revoked = new LogSourceStore({ filePath });
    expect(revoked.list()).toHaveLength(1);
    expect(() => revoked.runtime(created.id)).toThrow(LogSourceConfigurationError);
  });

  it('拒绝不验证证书的认证连接，无认证不保存凭据', () => {
    const store = new LogSourceStore({ filePath: tempFile(), allowedBaseUrls });
    expect(() => store.create(logSourceInputSchema.parse({ ...input, tlsVerify: false }))).toThrow();
    const created = store.create(logSourceInputSchema.parse({ ...input, auth: 'none' }));
    expect(created.hasCredential).toBe(false);
  });

  it('超过容量不写盘，已保存记录仍能重新读取', () => {
    const filePath = tempFile();
    const store = new LogSourceStore({ filePath, allowedBaseUrls });
    const body = logSourceInputSchema.parse(input);
    for (let i = 0; i < MAX_LOG_SOURCES; i += 1) store.create(body);
    const before = readFileSync(filePath, 'utf8');
    expect(() => store.create(body)).toThrow();
    expect(readFileSync(filePath, 'utf8')).toBe(before);
    expect(new LogSourceStore({ filePath, allowedBaseUrls }).list()).toHaveLength(MAX_LOG_SOURCES);
  });

  it('拒绝非法 JSON', () => {
    const filePath = tempFile();
    writeFileSync(filePath, '{not json', { mode: 0o600 });
    expect(() => new LogSourceStore({ filePath, allowedBaseUrls })).toThrow('不是合法 JSON');
  });
});
