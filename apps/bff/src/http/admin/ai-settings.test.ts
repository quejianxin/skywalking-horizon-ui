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

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiSettingsStore } from '../../ai/settings.js';
import type { ConfigSource } from '../../config/loader.js';
import { configSchema } from '../../config/schema.js';
import { makeRouteAuthHook } from '../../rbac/route-policy.js';
import { SessionStore } from '../../user/sessions.js';
import { registerAiSettingsAdminRoutes } from './ai-settings.js';

const URL = '/api/admin/ai-settings';
const FAKE_KEY = 'invented-test-key-never-real';
const input = {
  enabled: true,
  provider: 'openai-compatible' as const,
  model: 'test-model',
  baseUrl: 'https://example.test/v1',
  region: '',
  apiKey: FAKE_KEY,
};

const apps: FastifyInstance[] = [];
const directories: string[] = [];

beforeEach(() => {
  // 写模式只接受部署方在环境中批准的出站地址。
  vi.stubEnv('HORIZON_AI_ALLOWED_BASE_URLS', input.baseUrl);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function buildApp(writable = true) {
  const directory = mkdtempSync(join(tmpdir(), 'horizon-ai-settings-test-'));
  directories.push(directory);
  const filePath = writable ? join(directory, 'settings.json') : '';
  const cfg = configSchema.parse({
    ai: { enabled: false, provider: 'openai-compatible', model: '', baseUrl: '', region: '', apiKey: '' },
    rbac: { roles: { reader: ['ai-settings:read'], writer: ['ai-settings:read', 'ai-settings:write'] } },
  });
  const config: ConfigSource = {
    current: cfg, current_: () => cfg, path: '', onChange: () => () => {}, close: async () => {},
  };
  const sessions = new SessionStore({ ttlMinutes: 60 });
  const settings = new AiSettingsStore({ filePath, base: () => cfg.ai });
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  app.addHook('onRoute', makeRouteAuthHook({ config, sessions }));
  registerAiSettingsAdminRoutes(app, { config, sessions, settings });
  await app.ready();
  return { app, sessions, filePath };
}

function sessionCookie(sessions: SessionStore, role: string) {
  return { cookie: `horizon_sid=${sessions.create('test-user', [role]).sid}` };
}

describe('AI 管理设置接口', () => {
  it('拒绝未认证的读取和写入', async () => {
    const { app } = await buildApp();
    const get = await app.inject({ method: 'GET', url: URL });
    const put = await app.inject({ method: 'PUT', url: URL, payload: input });
    expect(get.statusCode).toBe(401);
    expect(put.statusCode).toBe(401);
    expect(get.json()).toEqual({ error: 'unauthenticated' });
    expect(put.json()).toEqual({ error: 'unauthenticated' });
  });

  it('只读权限可读取但不能写入', async () => {
    const { app, sessions } = await buildApp();
    const headers = sessionCookie(sessions, 'reader');
    const get = await app.inject({ method: 'GET', url: URL, headers });
    const put = await app.inject({ method: 'PUT', url: URL, headers, payload: input });
    expect(get.statusCode).toBe(200);
    expect(put.statusCode).toBe(403);
    expect(put.json()).toEqual({ error: 'permission_denied', verb: 'ai-settings:write' });
    const after = await app.inject({ method: 'GET', url: URL, headers });
    expect(after.json()).toEqual(get.json());
  });

  it('写权限保存配置，PUT 和 GET 均不回显密钥', async () => {
    const { app, sessions, filePath } = await buildApp();
    const headers = sessionCookie(sessions, 'writer');
    const put = await app.inject({ method: 'PUT', url: URL, headers, payload: input });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      enabled: true, provider: input.provider, model: input.model, baseUrl: input.baseUrl,
      hasApiKey: true, writable: true, source: 'settings-file',
    });
    expect(put.body).not.toContain(FAKE_KEY);
    expect(put.json()).not.toHaveProperty('apiKey');
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject(input);

    const get = await app.inject({ method: 'GET', url: URL, headers });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual(put.json());
    expect(get.body).not.toContain(FAKE_KEY);
    expect(get.json()).not.toHaveProperty('apiKey');
  });

  it('拒绝未获部署方批准的外发地址且不落盘', async () => {
    const { app, sessions, filePath } = await buildApp();
    const headers = sessionCookie(sessions, 'writer');
    const put = await app.inject({
      method: 'PUT',
      url: URL,
      headers,
      payload: { ...input, baseUrl: 'https://unapproved.example.invalid/v1' },
    });
    expect(put.statusCode).toBe(400);
    expect(put.json()).toMatchObject({ code: 'BAD_AI_SETTINGS' });
    expect(existsSync(filePath)).toBe(false);
  });

  it('未配置设置文件时可读取但不可写入', async () => {
    const { app, sessions } = await buildApp(false);
    const headers = sessionCookie(sessions, 'writer');
    const get = await app.inject({ method: 'GET', url: URL, headers });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ writable: false, source: 'environment', hasApiKey: false });
    const put = await app.inject({ method: 'PUT', url: URL, headers, payload: input });
    expect(put.statusCode).toBe(409);
    expect(put.json()).toMatchObject({ code: 'AI_SETTINGS_READONLY' });
    expect(put.body).not.toContain(FAKE_KEY);
    const after = await app.inject({ method: 'GET', url: URL, headers });
    expect(after.json()).toEqual(get.json());
  });
});
