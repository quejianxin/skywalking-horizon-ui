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

/**
 * Trace 诊断面板：打开才读取、合理失败可重试、缺记录如实说明。KPI 中的锁
 * 等待与异步分段按实际列出的行计数，计数缺失也不写成 0。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { i18n } from '@/i18n';
import TraceDiagnosisPopout from './TraceDiagnosisPopout.vue';

const { trace } = vi.hoisted(() => ({ trace: vi.fn() }));
vi.mock('@/api/client', () => ({ bffClient: { diagnosis: { trace } } }));

const BUNDLE = {
  traceId: 't1',
  traceMissing: false,
  summary: {
    traceId: 't1', traceMissing: false, note: null,
    entryCount: 2, databaseCount: 3, inferredCount: 1,
  },
  ruleReport: {
    traceId: 't1', modelAvailable: false, modelNote: '规则诊断（模型未参与）',
    findings: [{ ruleId: 'R-DB-SLOW', severity: 'critical', title: 'SQL 执行过慢', detail: '1241ms', evidence: ['seg#1'] }],
  },
  sql: {
    traceId: 't1', traceMissing: false,
    aggregates: [{
      template: 'SELECT 1 FROM pg_sleep(?)', count: 1, totalMs: 1241, minMs: 1241, maxMs: 1241,
      samples: [{ statement: 'SELECT 1 FROM pg_sleep(?)', durationMs: 1241, serviceCode: 'svc' }],
    }],
  },
  locks: {
    traceId: 't1', traceMissing: false,
    waits: [{ sessionId: 's1', lockType: 'row', waitMs: 800, verified: false, note: 'inferred' }],
  },
  async: {
    traceId: 't1', traceMissing: false,
    phases: [{ serviceCode: 'svc', endpointName: '/e', enqueueMs: 1, queueWaitMs: 2, executeMs: 3, verified: true, note: '' }],
  },
  threads: {
    traceId: 't1', traceMissing: false,
    threads: [{ serviceInstance: 'i1', threadKey: 'k', threadName: 'http-exec-1', spanCount: 2, totalMs: 1300, maxMs: 1200 }],
  },
};

function open(traceId: string | null = 't1') {
  return mount(TraceDiagnosisPopout, {
    props: { open: true, traceId },
    attachTo: document.body,
    global: { plugins: [i18n], stubs: { teleport: true } },
  });
}

describe('TraceDiagnosisPopout', () => {
  beforeEach(() => {
    trace.mockReset();
  });

  it('counts lock waits and async segments from the rows it lists', async () => {
    trace.mockResolvedValue(BUNDLE);
    const w = open();
    await flushPromises();
    expect(trace).toHaveBeenCalledWith('t1');
    expect(w.findAll('.dx-kpi-val').map((n) => n.text())).toEqual(['2', '3', '1', '1', '1']);
    expect(w.text()).toContain('R-DB-SLOW');
    expect(w.text()).toContain('SELECT 1 FROM pg_sleep(?)');
    expect(w.text()).toContain('http-exec-1');
    expect(w.text()).toContain('规则诊断（模型未参与）');
    w.unmount();
  });

  it('says the service has no record of the trace instead of showing empty sections', async () => {
    trace.mockResolvedValue({ ...BUNDLE, traceMissing: true, summary: { ...BUNDLE.summary } });
    const w = open();
    await flushPromises();
    expect(w.find('.dx-notice').text()).toContain('no record of this trace');
    expect(w.find('.dx-kpis').exists()).toBe(false);
    w.unmount();
  });

  it('reports a failed read and reads again on Retry', async () => {
    trace.mockRejectedValueOnce(new Error('DIAGNOSIS_UNREACHABLE'));
    const w = open();
    await flushPromises();
    expect(w.find('.dx-empty.err').text()).toContain('DIAGNOSIS_UNREACHABLE');
    trace.mockResolvedValue(BUNDLE);
    await w.find('.dx-empty.err button').trigger('click');
    await flushPromises();
    expect(trace).toHaveBeenCalledTimes(2);
    expect(w.text()).toContain('R-DB-SLOW');
    w.unmount();
  });

  it('reads nothing until it opens', async () => {
    const w = mount(TraceDiagnosisPopout, {
      props: { open: false, traceId: 't1' },
      attachTo: document.body,
      global: { plugins: [i18n], stubs: { teleport: true } },
    });
    await flushPromises();
    expect(trace).not.toHaveBeenCalled();
    w.unmount();
  });
});
