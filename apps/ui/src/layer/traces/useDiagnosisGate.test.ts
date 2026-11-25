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
 * 诊断开关只探测一次：403（缺 diagnosis:read）与 enabled:false 都按不可用处理，
 * 切换 Trace 不重复请求状态接口。
 */

import { describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import { useDiagnosisGate } from './useDiagnosisGate';

const { status } = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock('@/api/client', () => ({ bffClient: { diagnosis: { status } } }));

describe('useDiagnosisGate', () => {
  it('stays off until a trace is named, then turns on and stops probing', async () => {
    status.mockReset();
    status.mockResolvedValue({ enabled: true });
    const id = ref<string | null>(null);
    const gate = useDiagnosisGate(id);
    await flushPromises();
    expect(status).not.toHaveBeenCalled();
    expect(gate.enabled.value).toBe(false);

    id.value = 't1';
    await flushPromises();
    expect(status).toHaveBeenCalledTimes(1);
    expect(gate.enabled.value).toBe(true);

    gate.open.value = true;
    id.value = 't2';
    await flushPromises();
    expect(status).toHaveBeenCalledTimes(1);
    expect(gate.open.value).toBe(false);
    expect(gate.enabled.value).toBe(true);
  });

  it('treats a refused status read as unavailable', async () => {
    status.mockReset();
    status.mockRejectedValue(new Error('403'));
    const gate = useDiagnosisGate(ref<string | null>('t1'));
    await flushPromises();
    expect(gate.enabled.value).toBe(false);
  });

  it('stays off when the service reports itself disabled', async () => {
    status.mockReset();
    status.mockResolvedValue({ enabled: false });
    const gate = useDiagnosisGate(ref<string | null>('t1'));
    await flushPromises();
    expect(gate.enabled.value).toBe(false);
  });
});
