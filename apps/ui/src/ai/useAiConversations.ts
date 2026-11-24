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

// Conversation store (module singleton): holds the list + current transcript, drives the
// BFF chat stream (streamAnswer), and appends each SSE event into an ordered Block[].
// Persists to localStorage, live-syncs across tabs.
import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { useAuthStore } from '@/state/auth';
import { isCurrentEpoch, onSessionReset, sessionEpoch } from '@/state/sessionReset';
import { createHistoryStore, noopHistory, historyEnabledPref, setHistoryEnabledPref, type HistoryStore } from './historyStore';
import { aiHistorySettings, ensureAiConfig } from './useAiChat';
import { streamAnswer, type AiTurn, type AiStreamRange } from './aiStream';
import { AI_TIME_PRESETS, aiTimePresetId } from './scope';
import type { Block, Conversation, ChatMessage, ProposalBlock, ProposalStatus } from './types';

/** Text of a message's blocks for the LLM history. Prose carries forward
 *  verbatim; a figure-only assistant turn is summarised by its figure titles so
 *  the turn isn't empty (an empty turn would be dropped, creating a user→user
 *  gap in the replayed history). Tool chips are dropped. */
function textOf(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'text') parts.push(b.text);
    else if (b.kind === 'figure') {
      const titles = b.figures.map((f) => f.spec.title).filter(Boolean);
      parts.push(`(rendered figure${titles.length > 1 ? 's' : ''}: ${titles.join(', ') || b.title || 'chart'})`);
    } else if (b.kind === 'profiling') {
      parts.push(`(profiling: ${b.spec.profilingType} for ${b.spec.service})`);
    } else if (b.kind === 'process-topology') {
      parts.push(`(process map: ${b.spec.service})`);
    } else if (b.kind === 'podlogs') {
      parts.push(`(pod logs: ${b.spec.title})`);
    } else if (b.kind === 'hierarchy') {
      parts.push(`(hierarchy: ${b.spec.service})`);
    } else if (b.kind === 'topology') {
      parts.push(`(topology: ${b.spec.service})`);
    } else if (b.kind === 'deployment') {
      parts.push(`(deployment: ${b.spec.service})`);
    } else if (b.kind === 'instance-topology') {
      parts.push(`(instance map: ${b.spec.clientService} → ${b.spec.serverService})`);
    } else if (b.kind === 'endpoint-dependency') {
      parts.push(`(endpoint dependency: ${b.spec.service})`);
    } else if (b.kind === 'traces') {
      parts.push(`(traces: ${b.spec.service})`);
    } else if (b.kind === 'zipkin-traces') {
      parts.push(`(zipkin traces: ${b.spec.service})`);
    } else if (b.kind === 'logs') {
      parts.push(`(logs: ${b.spec.service})`);
    } else if (b.kind === 'browser-errors') {
      parts.push(`(browser errors: ${b.spec.service})`);
    } else if (b.kind === 'proposal') {
      // Carry the OUTCOME and the created task id. Without the id a follow-up
      // "analyze it" has nothing to pass to analyze_profiling, which then falls
      // back to the most recent task of that type — possibly a different one.
      // An approval WITHOUT a task id must say so: analyze_profiling would
      // otherwise fall back to the most recent task of that type and silently
      // analyse something the operator never approved.
      const outcome =
        b.status !== 'approved'
          ? b.status
          : b.taskId
            ? `approved, taskId ${b.taskId}`
            : 'approved but OAP returned no task id — no task to analyse by id; say so rather than analysing a different recent task';
      parts.push(`(suggested action: ${b.spec.profilingType} profiling for ${b.spec.service} — ${outcome})`);
    }
  }
  return parts.join(' ').trim();
}

/** Step scales with the window so long ranges don't blow the OAP bucket cap. */
function rangeForCurrentPreset(): AiStreamRange {
  const minutes = AI_TIME_PRESETS.find((p) => p.id === aiTimePresetId.value)?.minutes ?? 60;
  const endMs = Date.now();
  const startMs = endMs - minutes * 60_000;
  const step: AiStreamRange['step'] = minutes <= 360 ? 'MINUTE' : minutes <= 10080 ? 'HOUR' : 'DAY';
  return { startMs, endMs, step };
}

/** `active` — a turn is in flight (you are composing, or an answer is streaming),
 *  so the newest state is not written yet. `saved` — written to the browser
 *  store. `conflicted` — the stored copy was continued elsewhere and diverged;
 *  nothing was overwritten and the operator has to choose. */
export type ConversationStatus = 'active' | 'saved' | 'conflicted';

const conversations = ref<Conversation[]>([]);
const currentId = ref<string | null>(null);
const streaming = ref(false);
// Aborts the in-flight answer (stop button / panel close), so a closed panel
// stops consuming the model instead of streaming to nowhere.
let streamController: AbortController | null = null;

let store: HistoryStore = noopHistory;
let owner = '';
let storeIsReal = false;
const historyReady = ref(false);
let pendingHydration: Promise<void> | null = null;

function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `id-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

function applyLoaded(loaded: Conversation[]): void {
  conversations.value = loaded;
  if (!loaded.some((c) => c.id === currentId.value)) currentId.value = loaded[0]?.id ?? null;
}

function rebuildStore(): void {
  const settings = aiHistorySettings();
  storeIsReal = historyEnabledPref(owner) && !!settings && !!owner;
  store = storeIsReal && settings ? createHistoryStore(settings.mode, { maxBytes: settings.maxBytes }) : noopHistory;
}

function hydrate(): Promise<void> {
  if (pendingHydration) return pendingHydration;
  const nextOwner = useAuthStore().user?.username;
  if (!nextOwner || historyReady.value) return Promise.resolve();
  const epoch = sessionEpoch();
  pendingHydration = (async () => {
    if (!(await ensureAiConfig()) || !isCurrentEpoch(epoch)) return;
    owner = nextOwner;
    rebuildStore();
    const loaded = await store.load(nextOwner);
    if (!isCurrentEpoch(epoch)) return;
    applyLoaded(loaded);
    historyReady.value = true;
  })().finally(() => {
    if (isCurrentEpoch(epoch)) pendingHydration = null;
  });
  return pendingHydration;
}

// 串行执行历史写入；同一用户名重新登录后，排队中的旧操作也不能执行。
let mutations = Promise.resolve();
function enqueue(epoch: number, task: () => Promise<void>): Promise<void> {
  const run = mutations.then(() => (isCurrentEpoch(epoch) ? task() : undefined));
  mutations = run.catch(() => undefined);
  return run;
}
/** Per-conversation persistence state, keyed by uuid. Runtime only — never
 *  stored. `active` = a turn is in flight or there are unwritten changes;
 *  `saved` = written to the browser store; `conflicted` = the stored copy
 *  diverged (continued in another tab) and NOTHING was overwritten — the
 *  operator chooses. */
const status = ref<Record<string, ConversationStatus>>({});
function setStatus(id: string, s: ConversationStatus): void {
  status.value = { ...status.value, [id]: s };
}

function hasConversation(conv: Conversation): boolean {
  return conversations.value.includes(conv);
}

// 只写目标会话；排队期间删除或替换的会话不能被旧快照恢复。
function persist(conv: Conversation): void {
  const epoch = sessionEpoch();
  const own = owner;
  const canPublish = () => isCurrentEpoch(epoch) && hasConversation(conv);
  void enqueue(epoch, async () => {
    if (!hasConversation(conv)) return;
    const s = store;
    const { conflicted } = await s.upsert(own, [conv]);
    if (!canPublish()) return;
    if (conflicted.length) {
      setStatus(conv.id, 'conflicted');
      return;
    }
    setStatus(conv.id, 'saved');
    if (s !== store) return;
    const evicted = await s.enforceBudget(own);
    if (!isCurrentEpoch(epoch) || s !== store || !evicted.length) return;
    const gone = new Set(evicted);
    conversations.value = conversations.value.filter((c) => !gone.has(c.id));
    if (currentId.value && gone.has(currentId.value)) {
      currentId.value = conversations.value[0]?.id ?? null;
    }
  });
}

const current = computed<Conversation | null>(() => conversations.value.find((c) => c.id === currentId.value) ?? null);

onSessionReset(() => {
  streamController?.abort();
  streamController = null;
  streaming.value = false;
  conversations.value = [];
  currentId.value = null;
  status.value = {};
  store = noopHistory;
  storeIsReal = false;
  owner = '';
  pendingHydration = null;
  historyReady.value = false;
});

function newChat(): Conversation {
  const conv: Conversation = { id: uid(), title: '', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  conversations.value.unshift(conv);
  currentId.value = conv.id;
  setStatus(conv.id, 'active');
  persist(conversations.value[0]);
  // Return the reactive array element, not the raw literal — streamed mutations must go
  // through the proxy or the transcript won't re-render.
  return conversations.value[0];
}

function select(id: string): void {
  currentId.value = id;
}

async function remove(id: string): Promise<void> {
  const epoch = sessionEpoch();
  const own = owner;
  const s = store;
  conversations.value = conversations.value.filter((c) => c.id !== id);
  if (currentId.value === id) currentId.value = conversations.value[0]?.id ?? null;
  await enqueue(epoch, () => s.remove(own, id));
}

async function clearAll(): Promise<void> {
  const epoch = sessionEpoch();
  const own = owner;
  const s = store;
  conversations.value = [];
  currentId.value = null;
  await enqueue(epoch, () => s.clear(own));
}

// 关闭只暂停持久化；重新开启时合并本次会话与之前保存的记录。
async function setHistoryEnabled(on: boolean): Promise<void> {
  const epoch = sessionEpoch();
  const own = owner;
  setHistoryEnabledPref(own, on);
  rebuildStore();
  if (!on || !storeIsReal) return;
  const s = store;
  const stored = await s.load(own);
  if (!isCurrentEpoch(epoch) || s !== store) return;
  const haveIds = new Set(conversations.value.map((c) => c.id));
  const merged = [...conversations.value, ...stored.filter((c) => !haveIds.has(c.id))].sort((a, b) => b.updatedAt - a.updatedAt);
  applyLoaded(merged);
  await enqueue(epoch, async () => {
    if (s === store) await s.upsert(own, merged.filter(hasConversation));
  });
}

async function usageBytes(): Promise<number> {
  const epoch = sessionEpoch();
  const s = store;
  const bytes = await s.usageBytes(owner);
  return isCurrentEpoch(epoch) && s === store ? bytes : 0;
}

function ensureCurrent(): Conversation {
  const c = current.value;
  return c ?? newChat();
}

function appendToken(blocks: Block[], text: string): void {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === 'text') last.text += text;
  else blocks.push({ kind: 'text', text });
}

function applyTool(blocks: Block[], name: string, status: 'running' | 'done' | 'denied'): void {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === 'tool' && b.name === name) {
      b.status = status;
      return;
    }
  }
  blocks.push({ kind: 'tool', name, status });
}

async function send(text: string): Promise<void> {
  const q = text.trim();
  if (!q || streaming.value) return;
  const epoch = sessionEpoch();
  const conv = ensureCurrent();
  if (!conv.title) conv.title = q.slice(0, 60);

  conv.messages.push({ id: uid(), role: 'user', blocks: [{ kind: 'text', text: q }], at: Date.now() });
  // Prior turns (including the just-added user turn) become the LLM history;
  // the not-yet-streamed assistant placeholder is excluded.
  const history: AiTurn[] = conv.messages
    .map((m) => ({ role: m.role, content: textOf(m.blocks) }))
    .filter((m) => m.content.trim().length > 0);
  conv.messages.push({ id: uid(), role: 'assistant', blocks: [], streaming: true });
  const assistant = conv.messages[conv.messages.length - 1] as ChatMessage;

  setStatus(conv.id, 'active');
  streaming.value = true;
  streamController = new AbortController();
  try {
    for await (const ev of streamAnswer(history, rangeForCurrentPreset(), streamController.signal)) {
      if (!isCurrentEpoch(epoch)) break;
      if (ev.type === 'token') appendToken(assistant.blocks, ev.text);
      else if (ev.type === 'tool') applyTool(assistant.blocks, ev.name, ev.status);
      // Stamp the capture time so a reloaded (frozen) figure documents WHEN its
      // point-in-time data is from, not read as current.
      else if (ev.type === 'figure') assistant.blocks.push({ kind: 'figure', n: ev.n, title: ev.title, layout: ev.layout, figures: ev.figures, capturedAt: Date.now() });
      else if (ev.type === 'proposal') assistant.blocks.push({ kind: 'proposal', n: ev.n, spec: ev.spec, status: 'pending' });
      else if (ev.type === 'profiling') assistant.blocks.push({ kind: 'profiling', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'process-topology') assistant.blocks.push({ kind: 'process-topology', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'podlogs') assistant.blocks.push({ kind: 'podlogs', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'hierarchy') assistant.blocks.push({ kind: 'hierarchy', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'topology') assistant.blocks.push({ kind: 'topology', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'deployment') assistant.blocks.push({ kind: 'deployment', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'instance-topology') assistant.blocks.push({ kind: 'instance-topology', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'endpoint-dependency') assistant.blocks.push({ kind: 'endpoint-dependency', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'traces') assistant.blocks.push({ kind: 'traces', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'zipkin-traces') assistant.blocks.push({ kind: 'zipkin-traces', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'logs') assistant.blocks.push({ kind: 'logs', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'browser-errors') assistant.blocks.push({ kind: 'browser-errors', n: ev.n, spec: ev.spec, capturedAt: Date.now() });
      else if (ev.type === 'error') appendToken(assistant.blocks, `\n\n⚠ ${ev.message}`);
      else if (ev.type === 'done') break;
    }
  } finally {
    if (isCurrentEpoch(epoch)) {
      streamController = null;
      assistant.streaming = false;
      assistant.at = Date.now();
      streaming.value = false;
      conv.updatedAt = Date.now();
      persist(conv);
    }
  }
}

/** Stop the in-flight answer (Stop button / ESC). Marks the streaming assistant
 *  turn as interrupted so the transcript can show it was cut short. */
function stop(): void {
  if (streaming.value) {
    const msgs = current.value?.messages;
    const last = msgs?.[msgs.length - 1];
    if (last && last.role === 'assistant' && last.streaming) last.interrupted = true;
  }
  streamController?.abort();
}

type ResolveProposal = (
  decision: Exclude<ProposalStatus, 'pending' | 'proposed'>,
  patch?: Pick<ProposalBlock, 'taskId' | 'error'>,
) => void;

/** 审批前绑定原卡片和登录代次；允许切换会话，但不修改删除或替换后的卡片。 */
function captureProposal(block: ProposalBlock): ResolveProposal | undefined {
  if (block.status !== 'pending') return;
  const epoch = sessionEpoch();
  const conv = current.value;
  const message = conv?.messages.find((m) => m.blocks.includes(block));
  if (!conv || !message) return;
  return (decision, patch) => {
    if (!isCurrentEpoch(epoch) || !hasConversation(conv)) return;
    if (block.status !== 'pending' || !message.blocks.includes(block)) return;
    message.blocks = message.blocks.map((b) => (b === block ? { ...block, ...patch, status: decision } : b));
    conv.updatedAt = Date.now();
    persist(conv);
  };
}

/** Operator's answer to a conflict. `mine` force-writes this tab's version;
 *  `theirs` reloads the stored one, discarding the local divergence. */
async function resolveConflict(id: string, choice: 'mine' | 'theirs'): Promise<void> {
  const epoch = sessionEpoch();
  const own = owner;
  const s = store;
  await enqueue(epoch, async () => {
    if (s !== store) return;
    const conv = conversations.value.find((c) => c.id === id);
    if (!conv) return;
    const canPublish = () => isCurrentEpoch(epoch) && s === store && hasConversation(conv);
    if (choice === 'mine') {
      await s.upsert(own, [conv], { force: true });
      if (!canPublish()) return;
    } else {
      const stored = await s.loadOne(own, id);
      if (!canPublish() || !stored) return;
      conversations.value = conversations.value.map((c) => (c === conv ? stored : c));
    }
    setStatus(id, 'saved');
  });
}

export interface AiConversations {
  conversations: Ref<Conversation[]>;
  current: ComputedRef<Conversation | null>;
  currentId: Ref<string | null>;
  streaming: Ref<boolean>;
  send: (text: string) => Promise<void>;
  stop: () => void;
  captureProposal: (block: ProposalBlock) => ResolveProposal | undefined;
  newChat: () => Conversation;
  select: (id: string) => void;
  remove: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
  historyReady: Ref<boolean>;
  hydrate: () => Promise<void>;
  setHistoryEnabled: (on: boolean) => Promise<void>;
  historyEnabled: () => boolean;
  usageBytes: () => Promise<number>;
  /** Per-conversation persistence state, keyed by uuid. */
  status: Ref<Record<string, ConversationStatus>>;
  /** Resolve a conflicted conversation: keep THIS tab's version (force-write it)
   *  or take the stored one (discard the local divergence). */
  resolveConflict: (id: string, choice: 'mine' | 'theirs') => Promise<void>;
}

export function useAiConversations(): AiConversations {
  return {
    conversations,
    current,
    currentId,
    streaming,
    send,
    stop,
    captureProposal,
    newChat,
    select,
    remove,
    clearAll,
    historyReady,
    hydrate,
    setHistoryEnabled,
    historyEnabled: () => historyEnabledPref(owner),
    usageBytes,
    status,
    resolveConflict,
  };
}
