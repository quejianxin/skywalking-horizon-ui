<!--
  Licensed to the Apache Software Foundation (ASF) under one or more
  contributor license agreements.  See the NOTICE file distributed with
  this work for additional information regarding copyright ownership.
  The ASF licenses this file to You under the Apache License, Version 2.0
  (the "License"); you may not use this file except in compliance with
  the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->
<script setup lang="ts">
/**
 * 日志数据源管理页。
 *
 * Elasticsearch 只作为日志的只读附加源：指标、Trace、告警和拓扑仍由 OAP
 * 提供。页面可以新增、修改、删除数据源并做连接测试；凭据只进不出，表单
 * 里的密码框永远不回显已存值。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { bff, describeApiError } from '@/api/client';
import type {
  LogSourceAuth,
  LogSourceInput,
  LogSourceList,
  LogSourceView,
} from '@/api/client';
import Btn from '@/components/primitives/Btn.vue';
import Modal from '@/components/primitives/Modal.vue';
import { useAuthStore } from '@/state/auth';

const auth = useAuthStore();
const { t } = useI18n();

const DEFAULT_TRACE_FIELDS: readonly string[] = ['traceId', 'trace_id'];
const DEFAULT_MESSAGE_FIELDS: readonly string[] = ['message', 'msg', 'content'];

interface Draft {
  name: string;
  url: string;
  index: string;
  timeField: string;
  auth: LogSourceAuth;
  username: string;
  credential: string;
  tlsVerify: boolean;
  defaultWindowMinutes: number;
  maxRows: number;
  traceIdFields: string;
  messageFields: string;
}

interface TestResult {
  ok: boolean;
  text: string;
}

const list = ref<LogSourceList | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
const flash = ref<string | null>(null);
const formOpen = ref(false);
const editing = ref<LogSourceView | null>(null);
const formError = ref<string | null>(null);
const saving = ref(false);
const clearCredential = ref(false);
const testing = ref<string | null>(null);
const testResults = reactive<Record<string, TestResult>>({});
const pendingRemove = ref<LogSourceView | null>(null);
const removing = ref(false);
const removeError = ref<string | null>(null);

const draft = reactive<Draft>(blankDraft());

function blankDraft(): Draft {
  return {
    name: '',
    url: '',
    index: '',
    timeField: '@timestamp',
    auth: 'none',
    username: '',
    credential: '',
    tlsVerify: true,
    defaultWindowMinutes: 30,
    maxRows: 200,
    traceIdFields: DEFAULT_TRACE_FIELDS.join(', '),
    messageFields: DEFAULT_MESSAGE_FIELDS.join(', '),
  };
}

const canWrite = computed(
  () => (list.value?.writable ?? false) && auth.hasVerb('log-source:write'),
);

const credentialHint = computed(() =>
  editing.value?.hasCredential
    ? t('Leave blank to keep the stored credential. Changing the address, authentication or username clears it.')
    : t('The credential is stored on the server and is never shown again.'),
);

async function load(): Promise<void> {
  loading.value = true;
  try {
    list.value = await bff.adminLogSources.list();
    loadError.value = null;
  } catch (err) {
    loadError.value = describeApiError(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());

function authLabel(value: LogSourceAuth): string {
  if (value === 'basic') return t('Basic');
  if (value === 'apiKey') return t('API key');
  return t('None');
}

function applyDraft(source: LogSourceView | null): void {
  editing.value = source;
  Object.assign(draft, source
    ? {
        name: source.name,
        url: source.url,
        index: source.index,
        timeField: source.timeField,
        auth: source.auth,
        username: source.username,
        credential: '',
        tlsVerify: source.tlsVerify,
        defaultWindowMinutes: source.defaultWindowMinutes,
        maxRows: source.maxRows,
        traceIdFields: source.traceIdFields.join(', '),
        messageFields: source.messageFields.join(', '),
      }
    : blankDraft());
  clearCredential.value = false;
  formError.value = null;
  formOpen.value = true;
}

function fieldsOf(text: string, fallback: readonly string[]): string[] {
  const parts = text.split(',').map((part) => part.trim()).filter((part) => part !== '');
  return parts.length > 0 ? parts : [...fallback];
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function buildInput(): LogSourceInput | null {
  const name = draft.name.trim();
  const url = draft.url.trim();
  const index = draft.index.trim();
  if (name === '' || url === '' || index === '') {
    formError.value = t('Name, address and index pattern are required.');
    return null;
  }
  if (draft.auth === 'basic' && draft.username.trim() === '') {
    formError.value = t('Basic authentication needs a username.');
    return null;
  }
  const credential = clearCredential.value
    ? ''
    : draft.credential !== ''
      ? draft.credential
      : undefined;
  return {
    name,
    url,
    index,
    timeField: draft.timeField.trim() === '' ? '@timestamp' : draft.timeField.trim(),
    auth: draft.auth,
    username: draft.auth === 'basic' ? draft.username.trim() : '',
    ...(credential === undefined ? {} : { credential }),
    tlsVerify: draft.tlsVerify,
    defaultWindowMinutes: clampInt(draft.defaultWindowMinutes, 1, 1440, 30),
    maxRows: clampInt(draft.maxRows, 1, 1000, 200),
    traceIdFields: fieldsOf(draft.traceIdFields, DEFAULT_TRACE_FIELDS),
    messageFields: fieldsOf(draft.messageFields, DEFAULT_MESSAGE_FIELDS),
  };
}

async function save(): Promise<void> {
  formError.value = null;
  const input = buildInput();
  if (!input) return;
  saving.value = true;
  try {
    if (editing.value) await bff.adminLogSources.update(editing.value.id, input);
    else await bff.adminLogSources.create(input);
    formOpen.value = false;
    flash.value = t('Log source saved.');
    await load();
  } catch (err) {
    formError.value = describeApiError(err);
  } finally {
    saving.value = false;
  }
}

async function runTest(source: LogSourceView): Promise<void> {
  if (!canWrite.value || testing.value !== null) return;
  testing.value = source.id;
  delete testResults[source.id];
  try {
    const result = await bff.adminLogSources.test(source.id);
    testResults[source.id] = {
      ok: true,
      text: result.cluster === null
        ? t('Index is readable · {sampled} sample logs', { sampled: result.sampled })
        : t('Connected to {cluster} ({status}) · {nodes} nodes · {sampled} sample logs', {
          cluster: result.cluster, status: result.status ?? '—', nodes: result.nodes ?? '—', sampled: result.sampled,
        }),
    };
  } catch (err) {
    testResults[source.id] = {
      ok: false,
      text: t('Connection test failed: {err}', { err: describeApiError(err) }),
    };
  } finally {
    testing.value = null;
  }
}

function askRemove(source: LogSourceView): void {
  removeError.value = null;
  pendingRemove.value = source;
}

async function remove(): Promise<void> {
  const source = pendingRemove.value;
  if (!source) return;
  removing.value = true;
  try {
    await bff.adminLogSources.remove(source.id);
    delete testResults[source.id];
    pendingRemove.value = null;
    flash.value = t('Log source removed.');
    await load();
  } catch (err) {
    removeError.value = describeApiError(err);
  } finally {
    removing.value = false;
  }
}
</script>

<template>
  <div class="ls">
    <header class="ls__head">
      <div class="ls__kicker">{{ t('Admin') }}</div>
      <h1>{{ t('Log sources') }}</h1>
      <p class="ls__lede">
        {{ t('The Elasticsearch clusters the log search page reads. Horizon only reads them; metrics, traces, alarms and topology stay on OAP.') }}
      </p>
    </header>

    <div v-if="loading" class="ls__empty">{{ t('Loading…') }}</div>
    <div v-else-if="loadError" class="ls__error">{{ t('Failed to load: {err}', { err: loadError }) }}</div>
    <template v-else-if="list">
      <div v-if="!list.writable" class="ls__notice">
        {{ t('This deployment has not enabled log sources, so this page is read-only.') }}
      </div>
      <div v-else-if="!canWrite" class="ls__notice">
        {{ t('Read-only: your role can see log sources but not change them.') }}
      </div>

      <div class="ls__bar">
        <span v-if="flash" class="ls__flash">{{ flash }}</span>
        <Btn kind="primary" :disabled="!canWrite" @click="applyDraft(null)">
          {{ t('Add a log source') }}
        </Btn>
      </div>

      <p v-if="list.sources.length === 0" class="ls__empty">
        {{ t('No log source is configured yet. Add one to let the log search page query Elasticsearch.') }}
      </p>
      <table v-else class="ls__table">
        <thead>
          <tr>
            <th>{{ t('Name') }}</th>
            <th>{{ t('Address') }}</th>
            <th>{{ t('Index pattern') }}</th>
            <th>{{ t('Auth') }}</th>
            <th>{{ t('Window') }}</th>
            <th>{{ t('Max rows') }}</th>
            <th>{{ t('Credential') }}</th>
            <th>{{ t('Actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="source in list.sources" :key="source.id">
            <tr>
              <td>{{ source.name }}</td>
              <td class="ls__mono">{{ source.url }}</td>
              <td class="ls__mono">{{ source.index }}</td>
              <td>
                {{ authLabel(source.auth) }}
                <span v-if="source.username" class="ls__mono"> · {{ source.username }}</span>
              </td>
              <td>{{ source.defaultWindowMinutes }} min</td>
              <td>{{ source.maxRows }}</td>
              <td>{{ source.hasCredential ? t('Stored') : t('None') }}</td>
              <td class="ls__row-actions">
                <Btn v-if="canWrite" size="sm" :disabled="testing !== null" @click="runTest(source)">
                  {{ testing === source.id ? t('Testing…') : t('Test') }}
                </Btn>
                <Btn size="sm" :disabled="!canWrite" @click="applyDraft(source)">{{ t('Edit') }}</Btn>
                <Btn size="sm" kind="danger" :disabled="!canWrite" @click="askRemove(source)">
                  {{ t('Remove') }}
                </Btn>
              </td>
            </tr>
            <tr v-if="testResults[source.id]" class="ls__result">
              <td colspan="8" :class="testResults[source.id]!.ok ? 'is-ok' : 'is-err'">
                {{ testResults[source.id]!.text }}
              </td>
            </tr>
          </template>
        </tbody>
      </table>

      <p class="ls__foot">
        {{ t('Log sources are optional. When none is configured, the log search page offers nothing and the OAP log views keep working as before.') }}
      </p>
    </template>

    <Modal
      :open="formOpen"
      :title="editing ? t('Edit the log source') : t('Add a log source')"
      width="680px"
      @close="formOpen = false"
    >
      <div class="ls__form">
        <label class="ls__field">
          <span class="ls__label">{{ t('Name') }}</span>
          <input v-model="draft.name" type="text" autocomplete="off" maxlength="100" />
        </label>
        <label class="ls__field">
          <span class="ls__label">{{ t('Address') }}</span>
          <input v-model="draft.url" type="url" autocomplete="off" placeholder="http://elasticsearch:9200" />
          <span class="ls__hint">{{ t('An http(s) URL without user info, query parameters or fragment.') }}</span>
        </label>
        <label class="ls__field">
          <span class="ls__label">{{ t('Index pattern') }}</span>
          <input v-model="draft.index" type="text" autocomplete="off" placeholder="app-logs-*" />
        </label>
        <label class="ls__field">
          <span class="ls__label">{{ t('Time field') }}</span>
          <input v-model="draft.timeField" type="text" autocomplete="off" placeholder="@timestamp" />
        </label>
        <label class="ls__field">
          <span class="ls__label">{{ t('Authentication') }}</span>
          <select v-model="draft.auth">
            <option value="none">{{ t('None') }}</option>
            <option value="basic">{{ t('Basic') }}</option>
            <option value="apiKey">{{ t('API key') }}</option>
          </select>
        </label>
        <label v-if="draft.auth === 'basic'" class="ls__field">
          <span class="ls__label">{{ t('Username') }}</span>
          <input v-model="draft.username" type="text" autocomplete="off" />
        </label>
        <div v-if="draft.auth !== 'none'" class="ls__field">
          <label class="ls__label" for="ls-credential">
            {{ draft.auth === 'apiKey' ? t('API key credential') : t('Password') }}
          </label>
          <input
            id="ls-credential"
            v-model="draft.credential"
            type="password"
            autocomplete="new-password"
            :disabled="clearCredential"
            :placeholder="credentialHint"
          />
          <span class="ls__hint">{{ credentialHint }}</span>
          <label v-if="editing?.hasCredential" class="ls__check">
            <input v-model="clearCredential" type="checkbox" />
            <span>{{ t('Remove the stored credential on save') }}</span>
          </label>
        </div>
        <label class="ls__check">
          <input v-model="draft.tlsVerify" type="checkbox" />
          <span>{{ t('Verify the TLS certificate') }}</span>
        </label>
        <label class="ls__field">
          <span class="ls__label">{{ t('Default window (minutes)') }}</span>
          <input v-model.number="draft.defaultWindowMinutes" type="number" min="1" max="1440" />
        </label>
        <label class="ls__field">
          <span class="ls__label">{{ t('Maximum rows per page') }}</span>
          <input v-model.number="draft.maxRows" type="number" min="1" max="1000" />
        </label>
        <label class="ls__field">
          <span class="ls__label">{{ t('Trace id fields') }}</span>
          <input v-model="draft.traceIdFields" type="text" autocomplete="off" />
          <span class="ls__hint">{{ t('Comma-separated field names; the first non-empty one is used.') }}</span>
        </label>
        <label class="ls__field">
          <span class="ls__label">{{ t('Message fields') }}</span>
          <input v-model="draft.messageFields" type="text" autocomplete="off" />
          <span class="ls__hint">{{ t('Comma-separated field names; the first non-empty one is used.') }}</span>
        </label>
        <p v-if="formError" class="ls__error">{{ formError }}</p>
      </div>
      <template #footer>
        <Btn @click="formOpen = false">{{ t('cancel') }}</Btn>
        <Btn kind="primary" :disabled="saving" @click="save">
          {{ saving ? t('Saving…') : t('Save') }}
        </Btn>
      </template>
    </Modal>

    <Modal
      :open="pendingRemove !== null"
      :title="t('Remove this log source?')"
      @close="pendingRemove = null"
    >
      <p class="ls__confirm">
        {{ t('The log search page stops offering {name}. Its stored credential is deleted with it.', { name: pendingRemove?.name ?? '' }) }}
      </p>
      <p v-if="removeError" class="ls__error">{{ removeError }}</p>
      <template #footer>
        <Btn @click="pendingRemove = null">{{ t('cancel') }}</Btn>
        <Btn kind="danger" :disabled="removing" @click="remove">
          {{ removing ? t('Removing…') : t('Remove') }}
        </Btn>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.ls {
  padding: 20px 20px 60px;
  max-width: 1100px;
  margin: 0 auto;
  color: var(--sw-fg-1);
}
.ls__head { margin-bottom: 16px; }
.ls__kicker {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-semibold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-accent);
  margin-bottom: 4px;
}
.ls h1 {
  margin: 0;
  font-size: var(--sw-fs-xl);
  font-weight: var(--sw-fw-semibold);
  color: var(--sw-fg-0);
}
.ls__lede {
  margin: 6px 0 0;
  font-size: var(--sw-fs-base);
  line-height: var(--sw-lh-normal);
  color: var(--sw-fg-2);
}
.ls__notice {
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--sw-warn, var(--sw-line-2));
  border-radius: 6px;
  background: var(--sw-warn-soft, var(--sw-bg-2));
  font-size: var(--sw-fs-base);
}
.ls__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.ls__flash { color: var(--sw-ok); font-size: var(--sw-fs-base); }
.ls__empty { padding: 16px 0; color: var(--sw-fg-2); font-size: var(--sw-fs-base); }
.ls__table {
  width: 100%;
  border-collapse: collapse;
  border: 1px solid var(--sw-line);
  background: var(--sw-bg-1);
  font-size: var(--sw-fs-base);
}
.ls__table th,
.ls__table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--sw-line);
  text-align: left;
  vertical-align: top;
}
.ls__table th {
  font-size: var(--sw-fs-xs);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
  font-weight: var(--sw-fw-semibold);
}
.ls__mono { font-family: var(--rr-font-mono); font-size: var(--sw-fs-xs); }
.ls__row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.ls__result td { font-size: var(--sw-fs-xs); }
.ls__result td.is-ok { color: var(--sw-ok); }
.ls__result td.is-err { color: var(--sw-err); }
.ls__foot { margin-top: 12px; font-size: var(--sw-fs-xs); color: var(--sw-fg-3); line-height: var(--sw-lh-normal); }
.ls__form { display: grid; gap: 12px; }
.ls__field { display: grid; gap: 4px; }
.ls__label {
  font-size: var(--sw-fs-xs);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.ls__field input,
.ls__field select {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 9px;
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
  font-size: var(--sw-fs-base);
}
.ls__field input:disabled { opacity: 0.6; }
.ls__hint { font-size: var(--sw-fs-xs); color: var(--sw-fg-3); }
.ls__check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-1);
}
.ls__confirm { margin: 0; font-size: var(--sw-fs-base); line-height: var(--sw-lh-normal); }
.ls__error { color: var(--sw-err); font-size: var(--sw-fs-base); }
</style>
