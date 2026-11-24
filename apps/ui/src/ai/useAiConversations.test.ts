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

import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import type { ProfileTaskCreationResponse } from '@skywalking-horizon-ui/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSessionState } from '@/state/sessionReset';
import { i18n } from '@/i18n';
import ChatProposalBlock from './ChatProposalBlock.vue';
import { setHistoryEnabledPref, type HistoryStore, type UpsertResult } from './historyStore';
import type { Conversation, ProposalBlock } from './types';
import { useAiConversations } from './useAiConversations';

const { auth, history, config, createProfile } = vi.hoisted(() => ({
  auth: { isAuthenticated: true, user: { username: 'operator' } },
  history: {
    load: vi.fn<HistoryStore['load']>(),
    upsert: vi.fn<HistoryStore['upsert']>(),
    loadOne: vi.fn<HistoryStore['loadOne']>(),
    enforceBudget: vi.fn<HistoryStore['enforceBudget']>(),
    remove: vi.fn<HistoryStore['remove']>(),
    clear: vi.fn<HistoryStore['clear']>(),
    usageBytes: vi.fn<HistoryStore['usageBytes']>(),
  },
  config: vi.fn(),
  createProfile: vi.fn<() => Promise<ProfileTaskCreationResponse>>(),
}));

vi.mock('@/state/auth', () => ({ useAuthStore: () => auth }));
vi.mock('@/api/client', () => ({ bff: { ai: { config }, profile: { create: createProfile } } }));
vi.mock('./historyStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('./historyStore')>(),
  createHistoryStore: () => ({ ...history }),
}));

enableAutoUnmount(afterEach);

function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function conversation(id: string, title = id): Conversation {
  return { id, title, createdAt: 1, updatedAt: 1, messages: [] };
}

function proposalConversation(id: string): Conversation {
  const block: ProposalBlock = {
    kind: 'proposal', n: 1, status: 'pending',
    spec: {
      kind: 'profiling', profilingType: 'trace', layer: 'GENERAL', serviceId: id,
      service: id, durationMinutes: 1, endpoint: '/health',
      cause: '推测原因', rationale: '采集样本', expectation: '确认瓶颈',
    },
  };
  return { ...conversation(id), messages: [{ id: `${id}-message`, role: 'assistant', blocks: [block] }] };
}

const conv = useAiConversations();

async function hydrate(rows: Conversation[] = []): Promise<void> {
  history.load.mockResolvedValueOnce(rows);
  await conv.hydrate();
}

function activeProposal(): ProposalBlock {
  const block = conv.current.value?.messages[0]?.blocks[0];
  if (block?.kind !== 'proposal') throw new Error('缺少测试审批卡片');
  return block;
}

function mountActiveProposal() {
  return mount(ChatProposalBlock, {
    props: { block: activeProposal() },
    global: { plugins: [i18n] },
  });
}

const APPROVE_BUTTON = '.prop__btn--primary';
const SHARED_ID = 'shared-conversation';

beforeEach(() => {
  resetSessionState();
  vi.resetAllMocks();
  setHistoryEnabledPref(auth.user.username, true);
  config.mockResolvedValue({ ready: true, history: { mode: 'client', clientMaxBytes: 1024 } });
  history.load.mockResolvedValue([]);
  history.upsert.mockResolvedValue({ written: [], conflicted: [] });
  history.enforceBudget.mockResolvedValue([]);
});

describe('AI 会话历史的登录代次', () => {
  it('同账号重新登录后不会加载上次登录的在途历史', async () => {
    const old = deferred<Conversation[]>();
    history.load.mockReturnValueOnce(old.promise);
    const pending = conv.hydrate();
    await flushPromises();
    expect(history.load).toHaveBeenCalledOnce();

    resetSessionState();
    const current = deferred<Conversation[]>();
    history.load.mockReturnValueOnce(current.promise);
    const pendingCurrent = conv.hydrate();
    await flushPromises();
    old.resolve([conversation('old')]);
    await pending;
    expect(conv.conversations.value).toEqual([]);
    expect(conv.historyReady.value).toBe(false);
    expect(conv.hydrate()).toBe(pendingCurrent);

    current.resolve([conversation('current')]);
    await pendingCurrent;
    expect(conv.currentId.value).toBe('current');
    expect(conv.historyReady.value).toBe(true);
  });

  it('同账号重新登录后不执行排队中的旧新增、冲突写入、删除和清空', async () => {
    await hydrate([conversation(SHARED_ID)]);
    const first = deferred<UpsertResult>();
    history.upsert.mockReturnValueOnce(first.promise);
    const old = conv.newChat();
    await flushPromises();
    expect(history.upsert).toHaveBeenCalledOnce();

    conv.newChat();
    const keepMine = conv.resolveConflict(SHARED_ID, 'mine');
    const remove = conv.remove(SHARED_ID);
    const clear = conv.clearAll();
    resetSessionState();
    await hydrate([conversation(SHARED_ID)]);

    first.resolve({ written: [], conflicted: [old.id] });
    await Promise.all([keepMine, remove, clear]);
    expect(history.upsert).toHaveBeenCalledOnce();
    expect(history.remove).not.toHaveBeenCalled();
    expect(history.clear).not.toHaveBeenCalled();
    expect(conv.currentId.value).toBe(SHARED_ID);
    expect(conv.status.value).toEqual({});
  });

  it('同账号重新登录后忽略在途的配额淘汰结果和旧的用量', async () => {
    await hydrate();
    const budget = deferred<string[]>();
    const usage = deferred<number>();
    history.enforceBudget.mockReturnValueOnce(budget.promise);
    history.usageBytes.mockReturnValueOnce(usage.promise);
    const old = conv.newChat();
    const oldUsage = conv.usageBytes();
    await flushPromises();
    expect(history.enforceBudget).toHaveBeenCalledOnce();

    resetSessionState();
    await hydrate([conversation(old.id)]);
    budget.resolve([old.id]);
    usage.resolve(1024);
    expect(await oldUsage).toBe(0);
    await flushPromises();
    expect(conv.currentId.value).toBe(old.id);
    expect(conv.status.value).toEqual({});
  });

  it.each(['mine', 'theirs'] as const)('重新登录后忽略冲突选择 %s 的在途结果', async (choice) => {
    await hydrate([conversation(SHARED_ID, '旧会话')]);
    const write = deferred<UpsertResult>();
    const read = deferred<Conversation>();
    history.upsert.mockReturnValueOnce(write.promise);
    history.loadOne.mockReturnValueOnce(read.promise);
    const resolving = conv.resolveConflict(SHARED_ID, choice);
    await flushPromises();
    expect(choice === 'mine' ? history.upsert : history.loadOne).toHaveBeenCalledOnce();

    resetSessionState();
    await hydrate([conversation(SHARED_ID, '当前会话')]);
    write.resolve({ written: [SHARED_ID], conflicted: [] });
    read.resolve(conversation(SHARED_ID, '过期历史'));
    await resolving;
    expect(conv.current.value?.title).toBe('当前会话');
    expect(conv.status.value).toEqual({});
  });

  it('重新登录后不合并上次登录开启历史时的在途读取', async () => {
    await hydrate();
    await conv.setHistoryEnabled(false);
    const read = deferred<Conversation[]>();
    history.load.mockReturnValueOnce(read.promise);
    const enabling = conv.setHistoryEnabled(true);

    resetSessionState();
    await hydrate([conversation('current')]);
    read.resolve([conversation('old')]);
    await enabling;
    expect(conv.conversations.value.map((c) => c.id)).toEqual(['current']);
    expect(history.upsert).not.toHaveBeenCalled();
  });
});

describe('AI 历史开关', () => {
  it('关闭不清除历史，重新开启合并保存过的会话和只保留在内存的会话', async () => {
    await hydrate();
    await conv.setHistoryEnabled(false);
    expect(conv.historyEnabled()).toBe(false);
    const recent = conv.newChat();
    await flushPromises();
    expect(history.upsert).not.toHaveBeenCalled();
    expect(history.clear).not.toHaveBeenCalled();

    const saved = conversation('saved');
    history.load.mockResolvedValueOnce([saved]);
    await conv.setHistoryEnabled(true);
    expect(conv.historyEnabled()).toBe(true);
    expect(conv.currentId.value).toBe(recent.id);
    expect(history.upsert).toHaveBeenCalledExactlyOnceWith(auth.user.username, [recent, saved]);
  });

  it('再次关闭后不合并正在读取的记录或写入历史', async () => {
    await hydrate();
    const read = deferred<Conversation[]>();
    history.load.mockReturnValueOnce(read.promise);
    const enabling = conv.setHistoryEnabled(true);
    await conv.setHistoryEnabled(false);
    read.resolve([conversation('saved')]);
    await enabling;
    expect(conv.conversations.value).toEqual([]);
    expect(history.upsert).not.toHaveBeenCalled();
  });
});

describe('AI 会话的审批结果绑定', () => {
  it('审批时切换会话只更新和保存原卡片，即使组件接到另一张卡片', async () => {
    const original = proposalConversation('original');
    const other = proposalConversation('other');
    await hydrate([original, other]);
    const request = deferred<ProfileTaskCreationResponse>();
    createProfile.mockReturnValueOnce(request.promise);
    const card = mountActiveProposal();
    await card.get(APPROVE_BUTTON).trigger('click');
    expect(createProfile).toHaveBeenCalledOnce();

    conv.select(other.id);
    await card.setProps({ block: activeProposal() });
    request.resolve({ reachable: true, id: 'created-task' });
    await flushPromises();

    expect(conv.currentId.value).toBe(other.id);
    expect(activeProposal()).toMatchObject({ status: 'pending' });
    expect(other.updatedAt).toBe(1);
    expect(original.messages[0]?.blocks[0]).toMatchObject({ status: 'approved', taskId: 'created-task' });
    expect(history.upsert).toHaveBeenCalledExactlyOnceWith(auth.user.username, [original]);
  });

  it.each(['success', 'failure'] as const)('同账号重登后忽略旧审批的 %s 回包', async (outcome) => {
    await hydrate([proposalConversation(SHARED_ID)]);
    const request = deferred<ProfileTaskCreationResponse>();
    createProfile.mockReturnValueOnce(request.promise);
    const card = mountActiveProposal();
    await card.get(APPROVE_BUTTON).trigger('click');
    expect(createProfile).toHaveBeenCalledOnce();

    resetSessionState();
    await hydrate([proposalConversation(SHARED_ID)]);
    await card.setProps({ block: activeProposal() });
    if (outcome === 'success') request.resolve({ reachable: true, id: 'old-task' });
    else request.reject(new Error('旧审批失败'));
    await flushPromises();
    expect(activeProposal()).toMatchObject({ status: 'pending' });
    expect(history.upsert).not.toHaveBeenCalled();
  });

  it('原会话被冲突版本替换时不把审批结果应用到同 ID 的版本', async () => {
    await hydrate([proposalConversation(SHARED_ID)]);
    const request = deferred<ProfileTaskCreationResponse>();
    createProfile.mockReturnValueOnce(request.promise);
    const card = mountActiveProposal();
    await card.get(APPROVE_BUTTON).trigger('click');
    expect(createProfile).toHaveBeenCalledOnce();

    history.loadOne.mockResolvedValueOnce(proposalConversation(SHARED_ID));
    await conv.resolveConflict(SHARED_ID, 'theirs');
    await card.setProps({ block: activeProposal() });
    request.resolve({ reachable: true, id: 'old-task' });
    await flushPromises();
    expect(activeProposal()).toMatchObject({ status: 'pending' });
    expect(history.upsert).not.toHaveBeenCalled();
  });
});
