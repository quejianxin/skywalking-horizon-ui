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
  SkyWalking Trace 之上的诊断结论：规则判定、SQL 模板聚合、锁等待、异步
  时段与线程归因。Trace 瀑布、日志和拓扑仍由原生 Trace 视图负责，这里只
  补 OAP 协议没有的跨 Span 推断。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Modal from '@/components/primitives/Modal.vue';
import Icon from '@/components/icons/Icon.vue';
import { bffClient, type DiagnosisTraceBundle } from '@/api/client';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{ open: boolean; traceId: string | null }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const bundle = ref<DiagnosisTraceBundle | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
let round = 0;

async function load(): Promise<void> {
  if (!props.traceId) return;
  const mine = ++round;
  loading.value = true;
  error.value = null;
  bundle.value = null;
  try {
    const next = await bffClient.diagnosis.trace(props.traceId);
    if (mine === round) bundle.value = next;
  } catch (err) {
    if (mine === round) error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (mine === round) loading.value = false;
  }
}

watch(
  () => [props.open, props.traceId] as const,
  ([open]) => { if (open) void load(); },
  { immediate: true },
);

const findings = computed(() => bundle.value?.ruleReport.findings ?? []);
const sql = computed(() => bundle.value?.sql.aggregates ?? []);
const locks = computed(() => bundle.value?.locks.waits ?? []);
const phases = computed(() => bundle.value?.async.phases ?? []);
const threads = computed(() => bundle.value?.threads.threads ?? []);

function severityClass(severity: string): string {
  if (severity === 'critical') return 'sev-critical';
  if (severity === 'warning') return 'sev-warning';
  return 'sev-info';
}

/** 诊断服务的早期版本不返回全部计数：缺失显示 “—”，不把没读到写成 0。 */
function count(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
}
</script>

<template>
  <Modal :open="open" :title="t('Diagnosis')" width="min(1080px, 94vw)" @close="emit('close')">
    <section class="dx">
      <div v-if="loading" class="dx-empty"><Icon name="refresh" :size="14" class="dx-spin" />{{ t('Reading diagnosis…') }}</div>
      <div v-else-if="error !== null" class="dx-empty err">
        <span>{{ t('The diagnosis read failed') }} — {{ error }}</span>
        <button class="sw-btn small" type="button" @click="load">{{ t('Retry') }}</button>
      </div>
      <template v-else-if="bundle">
        <div v-if="bundle.traceMissing" class="dx-notice">{{ t('The diagnosis service has no record of this trace.') }}</div>
        <template v-else>
          <div class="dx-kpis">
            <div><div class="dx-kpi-label">{{ t('entry spans') }}</div><div class="dx-kpi-val">{{ count(bundle.summary.entryCount) }}</div></div>
            <div><div class="dx-kpi-label">{{ t('database spans') }}</div><div class="dx-kpi-val">{{ count(bundle.summary.databaseCount) }}</div></div>
            <div><div class="dx-kpi-label">{{ t('inferred mounts') }}</div><div class="dx-kpi-val">{{ count(bundle.summary.inferredCount) }}</div></div>
            <div><div class="dx-kpi-label">{{ t('lock waits') }}</div><div class="dx-kpi-val">{{ locks.length }}</div></div>
            <div><div class="dx-kpi-label">{{ t('async segments') }}</div><div class="dx-kpi-val">{{ phases.length }}</div></div>
          </div>

          <section class="dx-sec">
            <h6>{{ t('Rule findings') }}</h6>
            <div v-if="findings.length === 0" class="dx-empty">{{ t('No rule findings for this trace.') }}</div>
            <ul v-else class="dx-findings">
              <li v-for="f in findings" :key="f.ruleId + f.title" :class="severityClass(f.severity)">
                <div class="dx-finding-head">
                  <span class="dx-sev">{{ f.severity }}</span>
                  <span class="dx-finding-title">{{ f.title }}</span>
                  <span class="mono dim">{{ f.ruleId }}</span>
                </div>
                <p class="dx-detail">{{ f.detail }}</p>
                <ul v-if="f.evidence.length > 0" class="dx-evidence">
                  <li v-for="e in f.evidence" :key="e" class="mono">{{ e }}</li>
                </ul>
              </li>
            </ul>
          </section>

          <section class="dx-sec">
            <h6>{{ t('SQL templates') }}</h6>
            <div v-if="sql.length === 0" class="dx-empty">{{ t('No SQL spans in this trace.') }}</div>
            <table v-else class="dx-table">
              <thead>
                <tr>
                  <th>{{ t('template') }}</th>
                  <th class="num">{{ t('Count') }}</th>
                  <th class="num">{{ t('Total') }} (ms)</th>
                  <th class="num">{{ t('min') }}</th>
                  <th class="num">{{ t('max') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(a, i) in sql" :key="i">
                  <td class="mono dx-sql">
                    {{ a.template }}
                    <details v-if="a.samples.length > 0">
                      <summary>{{ t('samples') }}</summary>
                      <div v-for="(s, j) in a.samples" :key="j" class="dx-sample mono">
                        <span>{{ s.durationMs }} ms · {{ s.serviceCode }}</span>
                        <span class="dim">{{ s.statement }}</span>
                      </div>
                    </details>
                  </td>
                  <td class="num">{{ a.count }}</td>
                  <td class="num">{{ a.totalMs }}</td>
                  <td class="num">{{ a.minMs }}</td>
                  <td class="num">{{ a.maxMs }}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section class="dx-sec">
            <h6>{{ t('Lock waits') }}</h6>
            <div v-if="locks.length === 0" class="dx-empty">{{ t('No lock waits in this trace.') }}</div>
            <div v-for="(w, i) in locks" :key="i" class="dx-row">
              <span class="dx-badge" :class="w.verified ? 'ok' : 'warn'">{{ w.verified ? t('verified') : t('unverified') }}</span>
              <span class="mono">{{ w.lockType ?? '—' }}</span>
              <span class="dx-num">{{ w.waitMs }} ms</span>
              <span class="mono dim">{{ w.sessionId ?? '—' }}</span>
              <span class="dx-note">{{ w.note }}</span>
            </div>
          </section>

          <section class="dx-sec">
            <h6>{{ t('Async segments') }}</h6>
            <div v-if="phases.length === 0" class="dx-empty">{{ t('No async segments in this trace.') }}</div>
            <table v-else class="dx-table">
              <thead>
                <tr>
                  <th>{{ t('service') }}</th>
                  <th>{{ t('endpoint') }}</th>
                  <th class="num">{{ t('enqueue') }} (ms)</th>
                  <th class="num">{{ t('queue wait') }} (ms)</th>
                  <th class="num">{{ t('execute') }} (ms)</th>
                  <th>{{ t('verified') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(p, i) in phases" :key="i">
                  <td class="mono">{{ p.serviceCode }}</td>
                  <td>{{ p.endpointName }}</td>
                  <td class="num">{{ p.enqueueMs }}</td>
                  <td class="num">{{ p.queueWaitMs }}</td>
                  <td class="num">{{ p.executeMs }}</td>
                  <td><span class="dx-badge" :class="p.verified ? 'ok' : 'warn'">{{ p.verified ? t('verified') : t('unverified') }}</span></td>
                </tr>
              </tbody>
            </table>
          </section>

          <section class="dx-sec">
            <h6>{{ t('Threads') }}</h6>
            <div v-if="threads.length === 0" class="dx-empty">{{ t('No thread evidence in this trace.') }}</div>
            <table v-else class="dx-table">
              <thead>
                <tr>
                  <th>{{ t('instance') }}</th>
                  <th>{{ t('Thread') }}</th>
                  <th class="num">{{ t('spans') }}</th>
                  <th class="num">{{ t('Total') }} (ms)</th>
                  <th class="num">{{ t('max') }} (ms)</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(g, i) in threads" :key="i">
                  <td class="mono">{{ g.serviceInstance }}</td>
                  <td class="mono">{{ g.threadName }}</td>
                  <td class="num">{{ g.spanCount }}</td>
                  <td class="num">{{ g.totalMs }}</td>
                  <td class="num">{{ g.maxMs }}</td>
                </tr>
              </tbody>
            </table>
          </section>
        </template>
        <p v-if="bundle.ruleReport.modelNote" class="dx-model-note">{{ bundle.ruleReport.modelNote }}</p>
      </template>
    </section>
  </Modal>
</template>

<style scoped>
.dx { display: flex; flex-direction: column; gap: 14px; font-size: var(--sw-fs-sm); color: var(--sw-fg-1); }
.dx-empty {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  border: 1px dashed var(--sw-line-2); border-radius: 4px; color: var(--sw-fg-3);
}
.dx-empty.err { color: var(--sw-err); border-color: color-mix(in srgb, var(--sw-err) 40%, transparent); }
.dx-spin { animation: dx-spin 1s linear infinite; }
@keyframes dx-spin { to { transform: rotate(360deg); } }
.dx-notice {
  padding: 8px 12px; border-radius: 4px; color: var(--sw-warn);
  background: var(--sw-warn-soft); border: 1px solid color-mix(in srgb, var(--sw-warn) 35%, transparent);
}
.dx-kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
.dx-kpis > div { background: var(--sw-bg-2); border: 1px solid var(--sw-line); border-radius: 4px; padding: 8px 10px; }
.dx-kpi-label { color: var(--sw-fg-3); font-size: var(--sw-fs-xs); text-transform: uppercase; letter-spacing: var(--sw-ls-caps); }
.dx-kpi-val { font-size: var(--sw-fs-lg); font-weight: var(--sw-fw-semibold); }
.dx-sec { display: flex; flex-direction: column; gap: 8px; }
.dx-sec h6 { margin: 0; font-size: var(--sw-fs-xs); text-transform: uppercase; letter-spacing: var(--sw-ls-caps); color: var(--sw-fg-3); }
.dx-findings { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.dx-findings > li { background: var(--sw-bg-2); border: 1px solid var(--sw-line); border-left-width: 3px; border-radius: 4px; padding: 8px 10px; }
.dx-findings > li.sev-critical { border-left-color: var(--sw-err); }
.dx-findings > li.sev-warning { border-left-color: var(--sw-warn); }
.dx-findings > li.sev-info { border-left-color: var(--sw-info); }
.dx-finding-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dx-finding-title { font-weight: var(--sw-fw-medium); }
.dx-sev { font-size: var(--sw-fs-xs); text-transform: uppercase; letter-spacing: var(--sw-ls-caps); }
.sev-critical .dx-sev { color: var(--sw-err); }
.sev-warning .dx-sev { color: var(--sw-warn); }
.sev-info .dx-sev { color: var(--sw-info); }
.dx-detail { margin: 4px 0 0; color: var(--sw-fg-2); }
.dx-evidence { margin: 6px 0 0; padding-left: 18px; color: var(--sw-fg-3); }
.dx-table { width: 100%; border-collapse: collapse; }
.dx-table th, .dx-table td { padding: 5px 8px; border-bottom: 1px solid var(--sw-line); text-align: left; vertical-align: top; }
.dx-table th { color: var(--sw-fg-3); font-size: var(--sw-fs-xs); font-weight: var(--sw-fw-medium); }
.dx-table .num { text-align: right; white-space: nowrap; }
.dx-sql { max-width: 520px; word-break: break-all; }
.dx-sql details { margin-top: 4px; }
.dx-sample { display: flex; flex-direction: column; gap: 2px; padding: 3px 0; border-top: 1px dashed var(--sw-line-2); }
.dx-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 6px 8px; background: var(--sw-bg-2); border-radius: 4px; }
.dx-num { font-variant-numeric: tabular-nums; }
.dx-note { color: var(--sw-fg-3); }
.dx-badge { font-size: var(--sw-fs-xs); padding: 0 6px; border-radius: 3px; }
.dx-badge.ok { color: var(--sw-ok); background: var(--sw-ok-soft); }
.dx-badge.warn { color: var(--sw-warn); background: var(--sw-warn-soft); }
.dx-model-note { margin: 0; color: var(--sw-fg-3); font-size: var(--sw-fs-xs); }
</style>
