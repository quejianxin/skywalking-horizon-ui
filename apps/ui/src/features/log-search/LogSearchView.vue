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
<!--
  日志检索页（/logs）。

   ┌── header ───────────────────────────────────────────────────────────┐
   │ Logs / Log search                                                  │
   ├── 条件栏：数据源 · 时间窗 · 查询框 · 排序 · 每页条数 · [检索] ────┤
   ├── 状态行：命中数 · 耗时 · 索引 · 截断 / 不可达 ────────────────────┤
   ├── 字段侧栏 ──┬── 结果列表 + 翻页 ────────────┬── 日志→Trace 面板 ──┤
   │ 本页字段计数 │ 行内展开原始字段              │ 关联 Trace 与实体   │
   └──────────────┴───────────────────────────────┴─────────────────────┘

  字段侧栏只统计「本页已加载的行」，不是索引的完整映射——这一点写在侧栏里，
  免得被当成 schema。串联是显式动作：它会按 traceId 逐条读 OAP 的整条 Trace，
  自动触发会让每次翻页都变成几十次 OAP 读。
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAuthStore } from '@/state/auth';
import { useI18n } from 'vue-i18n';
import Btn from '@/components/primitives/Btn.vue';
import DateTimeField from '@/components/primitives/DateTimeField.vue';
import { useTracePopout } from '@/layer/traces/useTracePopout';
import LogResultList from './LogResultList.vue';
import LogTracePanel from './LogTracePanel.vue';
import { PAGE_SIZES, WINDOW_PRESETS, useLogSearch } from './useLogSearch';

const { t } = useI18n({ useScope: 'global' });
const { openTrace } = useTracePopout();
const auth = useAuthStore();
const canReadTraces = computed(() => auth.hasVerb('traces:read'));

const {
  sources, sourcesLoading, sourcesError, sourceId,
  query, windowMinutes, customRange, customStart, customEnd, sort, pageSize, page,
  result, running, error, errorPosition, ranOnce,
  link, linking, linkError,
  canSearch, hasMore, fields, rangeValid,
  run, nextPage, previousPage, changePageSize, linkTraces, loadSources, appendField,
} = useLogSearch();

const formError = ref('');

onMounted(() => {
  void loadSources();
});

function submit(): void {
  if (!rangeValid.value) {
    formError.value = t('The end of the range must come after its start.');
    return;
  }
  formError.value = '';
  void run();
}

function onPageSizeChange(event: Event): void {
  changePageSize(Number((event.target as HTMLSelectElement).value));
}

function openTraceAt(traceId: string, atMs: number | null): void {
  if (!canReadTraces.value) return;
  openTrace(traceId, 'native', typeof atMs === 'number' ? { at: atMs } : undefined);
}

function pickField(key: string): void {
  if (!appendField(key)) formError.value = t('That field name cannot be typed into the query as is.');
  else formError.value = '';
}
</script>

<template>
  <div class="lq">
    <header class="lq__head">
      <div class="lq__kicker">{{ t('Logs') }}</div>
      <h1>{{ t('Log search') }}</h1>
      <p class="lq__lede">
        {{ t('Search the Elasticsearch log sources of this deployment, then follow an incident’s logs into the traces they belong to. Metrics, traces, topology and alarms still come from OAP.') }}
      </p>
    </header>

    <div v-if="sourcesLoading" class="lq__empty">{{ t('Loading…') }}</div>
    <p v-else-if="sourcesError" class="lq__error">{{ t('Failed to load the datasources: {err}', { err: sourcesError }) }}</p>
    <p v-else-if="sources.length === 0" class="lq__empty">
      {{ t('No log datasource is configured. An administrator adds one under Log sources.') }}
    </p>

    <template v-else>
      <form class="lq__bar" @submit.prevent="submit">
        <label class="lq__field">
          <span class="lq__label">{{ t('Datasource') }}</span>
          <select v-model="sourceId" :aria-label="t('Datasource')">
            <option v-for="source in sources" :key="source.id" :value="source.id">{{ source.name }}</option>
          </select>
        </label>

        <label class="lq__field">
          <span class="lq__label">{{ t('Window') }}</span>
          <select v-model="windowMinutes" :disabled="customRange" :aria-label="t('Window')">
            <option v-for="preset in WINDOW_PRESETS" :key="preset.minutes" :value="preset.minutes">
              {{ t(preset.label) }}
            </option>
          </select>
        </label>

        <label class="lq__check">
          <input v-model="customRange" type="checkbox" />
          {{ t('Custom range') }}
        </label>

        <template v-if="customRange">
          <label class="lq__field">
            <span class="lq__label">{{ t('Start') }}</span>
            <DateTimeField v-model="customStart" :aria-label="t('Start')" />
          </label>
          <label class="lq__field">
            <span class="lq__label">{{ t('End') }}</span>
            <DateTimeField v-model="customEnd" :aria-label="t('End')" />
          </label>
        </template>

        <label class="lq__field lq__field--query">
          <span class="lq__label">{{ t('Query') }}</span>
          <input
            v-model="query"
            :placeholder="t('level:ERROR AND message:/timeout|reset/')"
            :aria-label="t('Query')"
            spellcheck="false"
          />
        </label>

        <label class="lq__field">
          <span class="lq__label">{{ t('Order') }}</span>
          <select v-model="sort" :aria-label="t('Order')">
            <option value="desc">{{ t('Newest first') }}</option>
            <option value="asc">{{ t('Oldest first') }}</option>
          </select>
        </label>

        <label class="lq__field">
          <span class="lq__label">{{ t('Rows per page') }}</span>
          <select :value="pageSize" :aria-label="t('Rows per page')" @change="onPageSizeChange">
            <option v-for="size in PAGE_SIZES" :key="size" :value="size">{{ size }}</option>
          </select>
        </label>

        <Btn kind="primary" type="submit" :disabled="!canSearch">
          {{ running ? t('Searching…') : t('Search') }}
        </Btn>
      </form>

      <p class="lq__syntax">
        {{ t('Full text, field:value, field:value*, field:/regex/, AND / OR / NOT and parentheses. A regex cannot start with * and is limited to 256 characters.') }}
      </p>

      <p v-if="formError" class="lq__error">{{ formError }}</p>
      <p v-if="error" class="lq__error">
        {{ error }}<template v-if="errorPosition !== null"> · {{ t('position {pos}', { pos: errorPosition }) }}</template>
      </p>

      <!-- 读不到数据源时没有命中数与耗时可言：`0 hits · 0 ms` 会被读成“查过了，
           确实没有”，与下面的不可达提示相互矛盾。只留下索引名作为上下文。 -->
      <div v-if="result" class="lq__meta">
        <template v-if="result.reachable">
          <span v-if="!result.truncated">{{ t('{total} hits · {ms} ms', { total: result.total, ms: result.tookMs }) }}</span>
          <span v-if="result.truncated" class="lq__warn">
            {{ t('The result is limited. The total may be incomplete.') }}
          </span>
        </template>
        <span class="lq__mono">{{ result.source.index }}</span>
      </div>
      <p v-if="result && !result.reachable" class="lq__error">
        {{ t('The datasource is unreachable: {err}', { err: result.error ?? '' }) }}
      </p>

      <div class="lq__body" :class="{ 'lq__body--traces': canReadTraces }">
        <aside class="lq__aside">
          <h2>{{ t('Fields on this page') }}</h2>
          <p class="lq__note">
            {{ t('Counted over the rows loaded on this page. Click a name to add it to the query.') }}
          </p>
          <ul v-if="fields.length > 0" class="lq__fields">
            <li v-for="field in fields" :key="field.key">
              <button class="lq__field-btn" :title="t('Add {name} to the query', { name: field.key })" @click="pickField(field.key)">
                <span class="lq__field-name">{{ field.key }}</span>
                <span class="lq__field-count">{{ field.rows }}</span>
              </button>
            </li>
          </ul>
          <p v-else class="lq__note">{{ t('Nothing loaded yet.') }}</p>
        </aside>

        <main class="lq__main">
          <p v-if="!ranOnce && !running" class="lq__empty">{{ t('Run a search to read this datasource.') }}</p>
          <p v-else-if="running && !result" class="lq__empty">{{ t('Reading…') }}</p>
          <!-- 读不到时列表的“没有匹配”会把失败说成空结果，所以这两处只在读到数据后出现。 -->
          <p v-else-if="result && !result.reachable" class="lq__empty">
            {{ t('Nothing could be read from this datasource.') }}
          </p>
          <LogResultList v-if="result && result.reachable" :logs="result.logs" :can-read-traces="canReadTraces" @open-trace="openTraceAt" />
          <div v-if="result && result.reachable" class="lq__pager">
            <Btn kind="ghost" size="sm" :disabled="page <= 1 || running" @click="previousPage">
              {{ t('Previous') }}
            </Btn>
            <span class="lq__pager-label">{{ t('Page {page}', { page }) }}</span>
            <Btn kind="ghost" size="sm" :disabled="!hasMore || running" @click="nextPage">
              {{ t('Next') }}
            </Btn>
          </div>
        </main>

        <LogTracePanel
          v-if="canReadTraces"
          :link="link"
          :linking="linking"
          :error="linkError"
          :enabled="!!result?.reachable && result.logs.length > 0 && !running"
          @link="linkTraces"
          @open-trace="openTraceAt"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.lq {
  padding: 20px 20px 60px;
  max-width: 1600px;
  margin: 0 auto;
  color: var(--sw-fg-1);
}
.lq__head { margin-bottom: 16px; }
.lq__kicker {
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-semibold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-accent);
  margin-bottom: 4px;
}
.lq h1 {
  margin: 0;
  font-size: var(--sw-fs-xl);
  font-weight: var(--sw-fw-semibold);
  color: var(--sw-fg-0);
}
.lq__lede {
  margin: 6px 0 0;
  max-width: 900px;
  font-size: var(--sw-fs-base);
  line-height: var(--sw-lh-normal);
  color: var(--sw-fg-2);
}
.lq__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  margin-bottom: 8px;
}
.lq__field { display: grid; gap: 3px; }
.lq__field--query { flex: 1 1 320px; min-width: 220px; }
.lq__label {
  font-size: var(--sw-fs-xs);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.lq__field select,
.lq__field input {
  box-sizing: border-box;
  padding: 6px 8px;
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
  font-size: var(--sw-fs-base);
}
.lq__field input { font-family: var(--rr-font-mono); }
.lq__field select:disabled { opacity: 0.6; }
.lq__check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--sw-fs-base);
  color: var(--sw-fg-1);
  padding-bottom: 6px;
}
.lq__syntax { margin: 0 0 10px; font-size: var(--sw-fs-xs); color: var(--sw-fg-3); }
.lq__error { margin: 0 0 10px; color: var(--sw-err); font-size: var(--sw-fs-base); }
.lq__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-2);
}
.lq__mono { font-family: var(--rr-font-mono); }
.lq__warn { color: var(--sw-warn); }
.lq__empty { padding: 16px 0; color: var(--sw-fg-2); font-size: var(--sw-fs-base); }
.lq__body {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.lq__body--traces { grid-template-columns: 210px minmax(0, 1fr) 360px; }
@media (max-width: 1200px) {
  .lq__body { grid-template-columns: minmax(0, 1fr); }
}
.lq__aside {
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  background: var(--sw-bg-1);
  padding: 10px;
}
.lq__aside h2 {
  margin: 0 0 4px;
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-semibold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.lq__note { margin: 0 0 8px; font-size: var(--sw-fs-xs); color: var(--sw-fg-3); line-height: var(--sw-lh-normal); }
.lq__fields { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; max-height: 60vh; overflow: auto; }
.lq__field-btn {
  width: 100%;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--sw-fg-1);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  cursor: pointer;
  text-align: left;
}
.lq__field-btn:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.lq__field-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lq__field-count { color: var(--sw-fg-3); }
.lq__main { min-width: 0; }
.lq__pager {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-2);
}
.lq__pager-label { min-width: 70px; text-align: center; }
</style>
