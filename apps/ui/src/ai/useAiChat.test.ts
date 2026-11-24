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

import { flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { api, auth, loadHistory } = vi.hoisted(() => ({
  api: { config: vi.fn() },
  auth: { isAuthenticated: true, user: { username: 'first' } },
  loadHistory: vi.fn(),
}));
vi.mock('@/api/client', () => ({ bff: { ai: api } }));
vi.mock('@/state/auth', () => ({ useAuthStore: () => auth }));
vi.mock('./historyStore', () => ({
  createHistoryStore: () => ({ load: loadHistory }),
  historyEnabledPref: () => true,
  noopHistory: {},
}));

import { resetSessionState } from '@/state/sessionReset';
import { useAiConversations } from './useAiConversations';
import { aiHistorySettings, refreshAiConfig, useAiChat } from './useAiChat';

describe('AI 助手配置刷新', () => {
  beforeEach(() => {
    resetSessionState();
    api.config.mockReset();
    loadHistory.mockReset();
    auth.user = { username: 'first' };
  });

  it('保存配置后更新当前会话的就绪状态', async () => {
    api.config.mockResolvedValueOnce({ ready: false, enabled: false });
    await refreshAiConfig();
    expect(useAiChat().ready.value).toBe(false);

    api.config.mockResolvedValueOnce({ ready: true, enabled: true });
    await refreshAiConfig();
    expect(useAiChat().ready.value).toBe(true);
  });

  it('较早请求的结果不能覆盖较新的配置', async () => {
    let resolveOld!: (value: unknown) => void;
    api.config.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const oldRequest = refreshAiConfig();
    api.config.mockResolvedValueOnce({ ready: true, enabled: true });
    await refreshAiConfig();
    resolveOld({ ready: false, enabled: false });
    await oldRequest;
    expect(useAiChat().ready.value).toBe(true);
  });

  it('被新请求取代的成功响应不能报告刷新成功', async () => {
    let resolveOld!: (value: unknown) => void;
    api.config.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const oldRequest = refreshAiConfig();
    api.config.mockRejectedValueOnce(new Error('不可用'));
    expect(await refreshAiConfig()).toBe(false);
    resolveOld({ ready: true, enabled: true });
    expect(await oldRequest).toBe(false);
    expect(useAiChat().ready.value).toBe(false);
  });

  it('历史加载等待并发刷新中的最新配置', async () => {
    api.config.mockRejectedValueOnce(new Error('不可用'));
    await refreshAiConfig();

    let resolveOld!: (value: unknown) => void;
    let resolveLatest!: (value: unknown) => void;
    api.config
      .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveLatest = resolve; }));
    const firstLoad = useAiChat().ensureConfig();
    const readHistorySettings = vi.fn(aiHistorySettings);
    const secondLoad = useAiChat().ensureConfig().then(readHistorySettings);
    const refresh = refreshAiConfig();
    resolveOld({ history: { mode: 'client', clientMaxBytes: 1 } });
    await flushPromises();
    expect(readHistorySettings).not.toHaveBeenCalled();
    expect(api.config).toHaveBeenCalledTimes(3);

    resolveLatest({ history: { mode: 'client', clientMaxBytes: 1024 } });
    expect(await secondLoad).toEqual({ mode: 'client', maxBytes: 1024 });
    await Promise.all([firstLoad, refresh]);
  });

  it('切换会话后只发布当前会话的配置', async () => {
    let resolveOld!: (value: unknown) => void;
    api.config.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    const oldRequest = refreshAiConfig();
    resetSessionState();
    expect(useAiChat().ready.value).toBe(false);

    api.config.mockResolvedValueOnce({ ready: false, starters: ['当前会话'] });
    await refreshAiConfig();
    resolveOld({ ready: true, starters: ['旧会话'] });
    expect(await oldRequest).toBe(false);
    expect(useAiChat().starters.value).toEqual(['当前会话']);
  });

  it('配置已就绪时仍等待当前会话的历史加载', async () => {
    let resolveOld!: (value: unknown) => void;
    let resolveCurrent!: (value: unknown) => void;
    const config = { ready: true, history: { mode: 'client', clientMaxBytes: 1024 } };
    api.config.mockResolvedValue(config);
    loadHistory
      .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveCurrent = resolve; }));
    const conv = useAiConversations();
    const oldLoad = conv.hydrate();
    await flushPromises();
    expect(useAiChat().ready.value).toBe(true);
    expect(conv.historyReady.value).toBe(false);
    expect(conv.hydrate()).toBe(oldLoad);

    resetSessionState();
    auth.user = { username: 'second' };
    const currentLoad = conv.hydrate();
    await flushPromises();
    resolveOld([{ id: 'old' }]);
    await oldLoad;
    expect(conv.historyReady.value).toBe(false);
    expect(conv.conversations.value).toEqual([]);
    resolveCurrent([{ id: 'current' }]);
    await currentLoad;
    expect(loadHistory.mock.calls).toEqual([['first'], ['second']]);
    expect(conv.historyReady.value).toBe(true);
    expect(conv.currentId.value).toBe('current');
  });

  it('探测失败后保留已有配置，恢复时清除失败状态', async () => {
    api.config.mockResolvedValueOnce({ ready: true });
    await refreshAiConfig();
    api.config.mockRejectedValueOnce(new Error('不可用'));
    expect(await refreshAiConfig()).toBe(false);
    expect(useAiChat().configFailed.value).toBe(true);
    expect(useAiChat().ready.value).toBe(true);
    api.config.mockResolvedValueOnce({ ready: false });
    expect(await refreshAiConfig()).toBe(true);
    expect(useAiChat().configFailed.value).toBe(false);
    expect(useAiChat().ready.value).toBe(false);
  });
});
