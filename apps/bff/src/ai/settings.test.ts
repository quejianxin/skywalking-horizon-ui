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

import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiConfig } from '../config/schema.js';
import { logger } from '../logger.js';
import {
  AiSettingsNotWritableError,
  AiSettingsStore,
  aiSettingsInputSchema,
} from './settings.js';

const BASE_URL = 'https://env.example.invalid/v1';
const APPROVED_URL = 'https://models.example.invalid/v1';
const SECOND_URL = 'https://other.example.invalid/v1';
const SYNTHETIC_KEY = 'synthetic-test-key';

function baseConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    enabled: false,
    provider: 'openai-compatible',
    model: 'env-model',
    baseUrl: BASE_URL,
    region: '',
    apiKey: 'env-key',
    ...overrides,
  } as AiConfig;
}

describe('AiSettingsStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-settings-'));
    filePath = join(dir, 'ai.json');
    vi.stubEnv('HORIZON_AI_ALLOWED_BASE_URLS', [BASE_URL, APPROVED_URL, SECOND_URL].join(','));
    vi.stubEnv('HORIZON_AI_ALLOWED_BEDROCK_REGIONS', 'us-east-1,us-west-2');
    vi.stubEnv('AWS_REGION', undefined);
    vi.stubEnv('AWS_DEFAULT_REGION', undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('without a settings file', () => {
    it('is read-only and serves the environment configuration', () => {
      const store = new AiSettingsStore({ filePath: '', base: () => baseConfig() });

      expect(store.writable).toBe(false);
      expect(store.effective()).toEqual(baseConfig());
      expect(store.view()).toMatchObject({
        model: 'env-model',
        hasApiKey: true,
        writable: false,
        source: 'environment',
      });
    });

    it('refuses to save', () => {
      const store = new AiSettingsStore({ filePath: '', base: () => baseConfig() });

      expect(() =>
        store.save({ enabled: false, provider: 'openai-compatible', model: '', baseUrl: '', region: '' }),
      ).toThrow(AiSettingsNotWritableError);
    });
  });

  describe('with a settings file', () => {
    it('starts disabled without a key when the file does not exist', () => {
      const store = new AiSettingsStore({ filePath, base: () => baseConfig({ enabled: true }) });

      expect(store.writable).toBe(true);
      expect(store.view().source).toBe('unset');
      expect(store.effective()).toMatchObject(baseConfig({ enabled: false, apiKey: '' }));
    });

    it('persists a save to a 0600 file and survives a restart', () => {
      const store = new AiSettingsStore({ filePath, base: () => baseConfig() });
      const saved = store.save({
        enabled: true,
        provider: 'openai-compatible',
        model: 'deepseek-chat',
        baseUrl: APPROVED_URL,
        region: '',
        apiKey: 'new-key',
      });

      expect(saved).toMatchObject({
        enabled: true,
        model: 'deepseek-chat',
        baseUrl: APPROVED_URL,
        hasApiKey: true,
        ready: true,
        writable: true,
        source: 'settings-file',
      });
      expect(statSync(filePath).mode & 0o777).toBe(0o600);

      const onDisk = JSON.parse(readFileSync(filePath, 'utf8'));
      expect(onDisk).toMatchObject({ version: 1, enabled: true, model: 'deepseek-chat', apiKey: 'new-key' });

      const restarted = new AiSettingsStore({ filePath, base: () => baseConfig() });
      expect(restarted.view()).toMatchObject({ model: 'deepseek-chat', source: 'settings-file', ready: true });
      expect(restarted.effective().apiKey).toBe('new-key');
    });

    it('keeps the existing key when the input omits it', () => {
      writeFileSync(
        filePath,
        JSON.stringify({ ...baseConfig(), version: 1, model: 'file-model', apiKey: 'file-key' }),
        { mode: 0o600 },
      );
      const store = new AiSettingsStore({ filePath, base: () => baseConfig() });

      store.save({
        enabled: true,
        provider: 'openai-compatible',
        model: 'file-model-2',
        baseUrl: BASE_URL,
        region: '',
      });

      expect(store.effective().apiKey).toBe('file-key');
      expect(JSON.parse(readFileSync(filePath, 'utf8')).apiKey).toBe('file-key');
    });

    it('does not restore the environment key on the first save', () => {
      const store = new AiSettingsStore({ filePath, base: () => baseConfig() });

      store.save({ enabled: true, provider: 'openai-compatible', model: 'model', baseUrl: BASE_URL, region: '' });

      expect(store.effective().apiKey).toBe('');
      expect(store.view().hasApiKey).toBe(false);
    });

    it('clears the key on an explicit empty string without falling back to the environment', () => {
      const store = new AiSettingsStore({ filePath, base: () => baseConfig() });
      store.save({ enabled: false, provider: 'openai-compatible', model: 'm', baseUrl: APPROVED_URL, region: '' });

      const view = store.save({
        enabled: false,
        provider: 'openai-compatible',
        model: 'm',
        baseUrl: APPROVED_URL,
        region: '',
        apiKey: '',
      });

      expect(view.hasApiKey).toBe(false);
      expect(store.effective().apiKey).toBe('');
    });

    it('更换获批地址时不会复用原地址的密钥', () => {
      const store = new AiSettingsStore({ filePath, base: () => baseConfig() });
      const settings = { enabled: true, provider: 'openai-compatible' as const, model: 'm', baseUrl: APPROVED_URL, region: '' };
      store.save({ ...settings, apiKey: SYNTHETIC_KEY });
      const view = store.save({ ...settings, baseUrl: SECOND_URL });
      expect(view).toMatchObject({ baseUrl: SECOND_URL, hasApiKey: false, ready: false });
      expect(store.effective().apiKey).toBe('');
    });

    it('部署未配置名单时，基础地址不视作对管理页的授权', () => {
      vi.stubEnv('HORIZON_AI_ALLOWED_BASE_URLS', undefined);
      const store = new AiSettingsStore({ filePath, base: () => baseConfig() });
      expect(() => store.save(baseConfig())).toThrow('baseUrl 未获部署方批准');
      expect(store.view()).toMatchObject({ source: 'unset', ready: false, hasApiKey: false });
    });

    it.each([
      { baseUrl: `${APPROVED_URL}/preview` },
      { baseUrl: 'https://models.example.invalid:8443/v1' },
      // 区域只对 Bedrock 生效，因此按 bedrock 保存来验证区域约束。
      { provider: 'bedrock' as const, region: 'ap-southeast-2' },
      { provider: 'bedrock' as const, region: 'us-west' },
      { apiKey: `${SYNTHETIC_KEY}\n` },
    ])('拒绝不符合出站约束的保存，不改写文件或生效配置：%j', (changes) => {
      const store = new AiSettingsStore({ filePath, base: () => baseConfig() });
      const settings = baseConfig({ enabled: false, baseUrl: APPROVED_URL, apiKey: SYNTHETIC_KEY });
      const original = store.save(settings);
      const contents = readFileSync(filePath, 'utf8');
      expect(() => store.save({ ...settings, ...changes })).toThrow();
      expect(store.view()).toEqual(original);
      expect(readFileSync(filePath, 'utf8')).toBe(contents);
    });

    it('保存 Bedrock 时固定已获批的环境回退区域，改区域不复用旧密钥', () => {
      vi.stubEnv('AWS_DEFAULT_REGION', 'us-west-2');
      const store = new AiSettingsStore({ filePath, base: () => baseConfig() });
      const settings = baseConfig({ enabled: true, provider: 'bedrock', baseUrl: '', region: '', apiKey: SYNTHETIC_KEY });
      expect(store.save(settings)).toMatchObject({ region: 'us-west-2', ready: true });
      expect(JSON.parse(readFileSync(filePath, 'utf8')).region).toBe('us-west-2');

      vi.stubEnv('AWS_REGION', 'us-east-1');
      const restarted = new AiSettingsStore({ filePath, base: () => baseConfig() });
      expect(restarted.view()).toMatchObject({ region: 'us-west-2', ready: true });
      expect(restarted.save({ ...settings, apiKey: undefined })).toMatchObject({ region: 'us-east-1', ready: false, hasApiKey: false });
    });

    it('为管理页列出部署方批准的地址与区域，且不含密钥', () => {
      const store = new AiSettingsStore({ filePath, base: () => baseConfig() });

      expect(store.view().approvedBaseUrls).toEqual([BASE_URL, APPROVED_URL, SECOND_URL].sort());
      expect(store.view().approvedRegions).toEqual(['us-east-1', 'us-west-2']);
      expect(store.view()).not.toHaveProperty('apiKey');
    });

    it('does not expose credentials embedded in a base configuration URL', () => {
      const store = new AiSettingsStore({ filePath, base: () => baseConfig({ baseUrl: 'https://user:secret@example.test/v1?token=secret' }) });
      expect(store.view().baseUrl).toBe('');
    });

    it('不会跟随旧临时文件的符号链接', () => {
      const target = join(dir, 'target');
      writeFileSync(target, 'unchanged');
      symlinkSync(target, `${filePath}.tmp`);
      const store = new AiSettingsStore({ filePath, base: () => baseConfig() });
      store.save({ enabled: false, provider: 'openai-compatible', model: 'm', baseUrl: APPROVED_URL, region: '', apiKey: 'fake-key' });
      expect(readFileSync(target, 'utf8')).toBe('unchanged');
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    });

    it('设置文件丢失后不会恢复旧密钥', () => {
      const store = new AiSettingsStore({ filePath, base: () => baseConfig({ enabled: true }) });
      store.save({ enabled: false, provider: 'openai-compatible', model: 'm', baseUrl: APPROVED_URL, region: '' });
      rmSync(filePath);
      const restarted = new AiSettingsStore({ filePath, base: () => baseConfig({ enabled: true }) });
      expect(restarted.effective()).toMatchObject({ enabled: false, apiKey: '' });
    });

    it('拒绝恢复权限过宽的文件，不输出文件内容', () => {
      const contents = JSON.stringify({ ...baseConfig(), apiKey: 'synthetic-secret' });
      writeFileSync(filePath, contents, { mode: 0o600 });
      chmodSync(filePath, 0o644);
      expect(() => new AiSettingsStore({ filePath, base: () => baseConfig() })).toThrow('仅所有者可访问');
      expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('synthetic-secret');
    });

    it('拒绝将符号链接作为设置文件', () => {
      const target = join(dir, 'backup.json');
      writeFileSync(target, JSON.stringify(baseConfig()), { mode: 0o600 });
      symlinkSync(target, filePath);
      expect(() => new AiSettingsStore({ filePath, base: () => baseConfig() })).toThrow('普通文件');
    });

    it('does not log malformed JSON contents', () => {
      writeFileSync(filePath, '{ "apiKey": "synthetic-secret", invalid }', { mode: 0o600 });
      expect(() => new AiSettingsStore({ filePath, base: () => baseConfig() })).toThrow();
      expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('synthetic-secret');
    });

    it('rejects incomplete files rather than sending an environment key to another endpoint', () => {
      writeFileSync(filePath, JSON.stringify({ baseUrl: 'https://other.example/v1' }), { mode: 0o600 });
      expect(() => new AiSettingsStore({ filePath, base: () => baseConfig() })).toThrow('AI 设置文件字段不合法');
    });

    it.each([
      { enabled: true, baseUrl: 'file:///tmp/model' },
      { enabled: true, baseUrl: '' },
      { enabled: true, model: ' ' },
      { apiKey: null },
      { version: 2 },
    ])('拒绝恢复不符合保存约束的设置：%j', (overrides) => {
      writeFileSync(filePath, JSON.stringify({ ...baseConfig(), ...overrides }), { mode: 0o600 });
      expect(() => new AiSettingsStore({ filePath, base: () => baseConfig() })).toThrow('AI 设置文件字段不合法');
    });

    it('reads the base lazily so a config reload is observed', () => {
      let base = baseConfig({ model: 'first' });
      const store = new AiSettingsStore({ filePath, base: () => base });
      expect(store.effective().model).toBe('first');

      base = baseConfig({ model: 'second' });
      expect(store.effective().model).toBe('second');
    });

    it.each([
      ['invalid JSON', '{ not json'],
      ['a field of the wrong type', JSON.stringify({ enabled: 'yes' })],
      ['a non-object document', JSON.stringify(['x'])],
    ])('rejects %s instead of restoring the environment configuration', (_label, body) => {
      writeFileSync(filePath, body, { mode: 0o600 });
      expect(() => new AiSettingsStore({ filePath, base: () => baseConfig() })).toThrow();
      expect(logger.error).toHaveBeenCalled();
    });
  });
});

describe('aiSettingsInputSchema', () => {
  const valid = {
    enabled: true,
    provider: 'openai-compatible' as const,
    model: 'deepseek-chat',
    baseUrl: APPROVED_URL,
    region: '',
  };

  it('accepts a complete openai-compatible input', () => {
    expect(aiSettingsInputSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts bedrock with a blank baseUrl and region', () => {
    expect(
      aiSettingsInputSchema.safeParse({ ...valid, provider: 'bedrock', baseUrl: '', region: '' }).success,
    ).toBe(true);
  });

  it('accepts anthropic with a blank baseUrl and region', () => {
    expect(
      aiSettingsInputSchema.safeParse({ ...valid, provider: 'anthropic', baseUrl: '', region: '' }).success,
    ).toBe(true);
  });

  it('requires a model when enabled', () => {
    const result = aiSettingsInputSchema.safeParse({ ...valid, model: '' });
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues.map((i) => i.path.join('.'))).toContain('model');
  });

  it('allows a blank model while disabled', () => {
    expect(aiSettingsInputSchema.safeParse({ ...valid, enabled: false, model: '' }).success).toBe(true);
  });

  it('requires a baseUrl for openai-compatible when enabled', () => {
    const result = aiSettingsInputSchema.safeParse({ ...valid, baseUrl: '' });
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues.map((i) => i.path.join('.'))).toContain('baseUrl');
  });

  it('rejects a non-http baseUrl', () => {
    const result = aiSettingsInputSchema.safeParse({ ...valid, baseUrl: 'ftp://example/v1' });
    expect(result.success).toBe(false);
  });

  it.each(['https://user:secret@example.test/v1', 'https://example.test/v1?token=secret', 'https://example.test/v1#secret'])('rejects URL credentials and parameters', (baseUrl) => {
    expect(aiSettingsInputSchema.safeParse({ ...valid, baseUrl }).success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(aiSettingsInputSchema.safeParse({ ...valid, surprise: 1 }).success).toBe(false);
  });
});
