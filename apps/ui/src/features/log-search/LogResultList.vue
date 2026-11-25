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
  检索结果列表。一行 = 一条日志；点开行内展开原始字段，点 traceId 打开
  OAP 的整条 Trace。时间与层级在前，消息占满中间，链路 id 靠右——与日志页
  其余列表保持同一密度。
-->
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { EsLogRow } from '@/api/client';
import { timestampLabel } from '@/utils/formatters';

const props = defineProps<{ logs: EsLogRow[]; canReadTraces: boolean }>();
const emit = defineEmits<{
  'open-trace': [traceId: string, atMs: number | null];
}>();

const { t } = useI18n({ useScope: 'global' });

// 每次检索或翻页都重新挂载列表；本页行序稳定，跨索引时 ES _id 不一定唯一。
const openRow = ref<number | null>(null);

function toggle(rowIndex: number): void {
  openRow.value = openRow.value === rowIndex ? null : rowIndex;
}

const LEVEL_TONE: Record<string, string> = {
  error: 'err', fatal: 'err', severe: 'err', critical: 'err',
  warn: 'warn', warning: 'warn',
  info: 'info', notice: 'info',
  debug: 'muted', trace: 'muted',
};

function levelTone(level: string): string {
  return LEVEL_TONE[level.toLowerCase()] ?? 'muted';
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** 只留后 8 位：完整 id 太长会挤掉消息列，完整值在展开的字段里。 */
function shortTraceId(traceId: string): string {
  return traceId.length <= 8 ? traceId : `…${traceId.slice(-8)}`;
}
</script>

<template>
  <div class="lr">
    <p v-if="props.logs.length === 0" class="lr__empty">{{ t('No logs match this query in the window.') }}</p>
    <template v-else>
      <div
        v-for="(row, rowIndex) in props.logs"
        :key="rowIndex"
        class="lr__item"
        :class="{ 'is-open': openRow === rowIndex }"
      >
        <div class="lr__row" role="button" tabindex="0" @click="toggle(rowIndex)" @keydown.enter.self="toggle(rowIndex)" @keydown.space.self.prevent="toggle(rowIndex)">
          <span class="lr__time">{{ row.timestamp === null ? '—' : timestampLabel(row.timestamp) }}</span>
          <span v-if="row.level" class="lr__level" :class="`is-${levelTone(row.level)}`">{{ row.level }}</span>
          <span class="lr__msg">{{ row.message || t('(no message field)') }}</span>
          <span v-if="row.service" class="lr__service">{{ row.service }}</span>
          <button
            v-if="row.traceId && props.canReadTraces"
            class="lr__trace"
            :title="row.traceId"
            @click.stop="emit('open-trace', row.traceId, row.timestamp)"
          >{{ t('Trace') }} {{ shortTraceId(row.traceId) }}</button>
        </div>
        <dl v-if="openRow === rowIndex" class="lr__fields">
          <template v-for="(value, key) in row.fields" :key="String(key)">
            <dt>{{ key }}</dt>
            <dd>{{ valueText(value) }}</dd>
          </template>
        </dl>
      </div>
    </template>
  </div>
</template>

<style scoped>
.lr { border: 1px solid var(--sw-line); background: var(--sw-bg-1); border-radius: 6px; overflow: hidden; }
.lr__empty { margin: 0; padding: 18px 14px; color: var(--sw-fg-2); font-size: var(--sw-fs-base); }
.lr__item { border-bottom: 1px solid var(--sw-line); }
.lr__item:last-child { border-bottom: none; }
.lr__row {
  display: grid;
  grid-template-columns: 150px auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: var(--sw-fs-base);
}
.lr__row:hover { background: var(--sw-bg-2); }
.lr__item.is-open .lr__row { background: var(--sw-bg-3, var(--sw-bg-2)); }
.lr__time { font-family: var(--rr-font-mono); font-size: var(--sw-fs-xs); color: var(--sw-fg-3); white-space: nowrap; }
.lr__level {
  font-size: var(--sw-fs-xs);
  font-family: var(--rr-font-mono);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
}
.lr__level.is-err { color: var(--sw-err); }
.lr__level.is-warn { color: var(--sw-warn); }
.lr__level.is-info { color: var(--sw-info); }
.lr__level.is-muted { color: var(--sw-fg-3); }
.lr__msg {
  color: var(--sw-fg-0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lr__service { font-size: var(--sw-fs-xs); color: var(--sw-fg-2); white-space: nowrap; }
.lr__trace {
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  background: transparent;
  color: var(--sw-accent);
  font-family: var(--rr-font-mono);
  font-size: var(--sw-fs-xs);
  padding: 2px 6px;
  cursor: pointer;
  white-space: nowrap;
}
.lr__trace:hover { border-color: var(--sw-accent); }
.lr__fields {
  margin: 0;
  padding: 8px 12px 12px;
  display: grid;
  grid-template-columns: minmax(120px, max-content) minmax(0, 1fr);
  gap: 4px 14px;
  background: var(--sw-bg-0, var(--sw-bg-1));
  font-size: var(--sw-fs-xs);
}
.lr__fields dt { font-family: var(--rr-font-mono); color: var(--sw-fg-3); }
.lr__fields dd {
  margin: 0;
  color: var(--sw-fg-1);
  font-family: var(--rr-font-mono);
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
