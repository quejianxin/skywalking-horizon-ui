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
import { useI18n } from 'vue-i18n';
import type { EsLogTraceLinkResponse, LogEntity, LogEntityKind } from '@/api/client';
import { timestampLabel } from '@/utils/formatters';
import Btn from '@/components/primitives/Btn.vue';

const props = defineProps<{
  link: EsLogTraceLinkResponse | null;
  linking: boolean;
  error: string;
  /** 有结果才谈得上串联。 */
  enabled: boolean;
}>();

const emit = defineEmits<{
  link: [];
  'open-trace': [traceId: string, atMs: number];
}>();

const { t } = useI18n({ useScope: 'global' });

const ENTITY_KINDS: ReadonlyArray<{ kind: LogEntityKind; label: string }> = [
  { kind: 'mq', label: 'Message queues' },
  { kind: 'db', label: 'Databases' },
  { kind: 'rpc', label: 'RPC' },
  { kind: 'http', label: 'HTTP clients' },
];

function entitiesOf(kind: LogEntityKind): LogEntity[] {
  return props.link?.entities[kind] ?? [];
}

/** 毫秒耗时：不足 1 秒按 ms 显示，超过则按秒保留两位。 */
function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
</script>

<template>
  <section class="lt">
    <header class="lt__head">
      <h2>{{ t('Linked traces') }}</h2>
      <Btn kind="ghost" size="sm" :disabled="!props.enabled || props.linking || !!props.link" @click="emit('link')">
        {{ props.linking ? t('Linking…') : t('Link traces') }}
      </Btn>
    </header>

    <p class="lt__hint">
      {{ t('Reads the traces behind the trace ids on this page and groups their MQ, database, RPC and HTTP spans.') }}
    </p>

    <p v-if="props.error" class="lt__error">{{ props.error }}</p>

    <template v-if="props.link">
      <p class="lt__counts">
        {{ t('{linked} logs linked · {unlinked} without a trace id', {
          linked: props.link.linkedCount, unlinked: props.link.unlinkedCount,
        }) }}
      </p>
      <p v-if="props.link.missingTraceCount || props.link.failedTraceCount || props.link.skippedTraceCount" class="lt__notice">
        {{ t('Trace IDs: {missing} not found · {failed} failed to load · {skipped} skipped (limit reached)', {
          missing: props.link.missingTraceCount, failed: props.link.failedTraceCount, skipped: props.link.skippedTraceCount,
        }) }}
      </p>

      <ol v-if="props.link.traces.length > 0" class="lt__traces">
        <li v-for="trace in props.link.traces" :key="trace.traceId">
          <button class="lt__trace" @click="emit('open-trace', trace.traceId, trace.startMs)">
            <span class="lt__trace-head">
              <span class="lt__dot" :class="trace.isError ? 'is-err' : 'is-ok'" />
              <span class="lt__trace-time">{{ timestampLabel(trace.startMs) }}</span>
              <span class="lt__trace-dur">{{ formatMs(trace.durationMs) }}</span>
            </span>
            <span class="lt__trace-services">{{ trace.services.join(' · ') || trace.traceId }}</span>
            <span class="lt__trace-meta">{{ t('{n} spans', { n: trace.spanCount }) }}</span>
          </button>
        </li>
      </ol>

      <div v-for="group in ENTITY_KINDS" v-show="entitiesOf(group.kind).length > 0" :key="group.kind" class="lt__group">
        <h3>{{ t(group.label) }}</h3>
        <ul>
          <li v-for="entity in entitiesOf(group.kind)" :key="`${entity.component}:${entity.peer}:${entity.name}`">
            <span class="lt__entity-name">{{ entity.name }}</span>
            <span v-if="entity.peer && entity.peer !== entity.name" class="lt__entity-peer">{{ entity.peer }}</span>
            <span class="lt__entity-meta">{{ t('{n} spans', { n: entity.spanCount }) }}</span>
          </li>
        </ul>
      </div>

      <p class="lt__foot">
        {{ t('A log line carries a trace id but no span id, so a trace opens whole rather than at one span.') }}
      </p>
    </template>
  </section>
</template>

<style scoped>
.lt {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  background: var(--sw-bg-1);
  padding: 12px;
  min-width: 0;
}
.lt__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.lt__head h2 {
  margin: 0;
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-semibold);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.lt__hint,
.lt__foot { margin: 0; font-size: var(--sw-fs-xs); color: var(--sw-fg-3); line-height: var(--sw-lh-normal); }
.lt__error { margin: 0; color: var(--sw-err); font-size: var(--sw-fs-base); }
.lt__counts { margin: 0; font-size: var(--sw-fs-base); color: var(--sw-fg-1); }
.lt__notice {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-2);
  font-size: var(--sw-fs-xs);
  line-height: var(--sw-lh-normal);
}
.lt__traces { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.lt__trace {
  width: 100%;
  text-align: left;
  display: grid;
  gap: 2px;
  padding: 6px 8px;
  border: 1px solid var(--sw-line);
  border-radius: 5px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
  cursor: pointer;
}
.lt__trace:hover { border-color: var(--sw-accent); }
.lt__trace-head { display: flex; align-items: center; gap: 6px; }
.lt__dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.lt__dot.is-ok { background: var(--sw-ok); }
.lt__dot.is-err { background: var(--sw-err); }
.lt__trace-time { font-family: var(--rr-font-mono); font-size: var(--sw-fs-xs); color: var(--sw-fg-2); }
.lt__trace-dur { margin-left: auto; font-family: var(--rr-font-mono); font-size: var(--sw-fs-xs); color: var(--sw-fg-1); }
.lt__trace-services {
  font-size: var(--sw-fs-xs);
  color: var(--sw-fg-0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lt__trace-meta { font-size: var(--sw-fs-xs); color: var(--sw-fg-3); }
.lt__group h3 {
  margin: 6px 0 4px;
  font-size: var(--sw-fs-xs);
  text-transform: uppercase;
  letter-spacing: var(--sw-ls-caps);
  color: var(--sw-fg-3);
}
.lt__group ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.lt__group li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: var(--sw-fs-xs);
  padding: 2px 0;
}
.lt__entity-name { color: var(--sw-fg-0); font-family: var(--rr-font-mono); }
.lt__entity-peer {
  color: var(--sw-fg-3);
  font-family: var(--rr-font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lt__entity-meta { margin-left: auto; color: var(--sw-fg-3); white-space: nowrap; }
</style>
