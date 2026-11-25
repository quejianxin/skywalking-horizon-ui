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
 * 诊断入口的开关。状态接口同时承担配置与授权判断：服务未配置时回答
 * `enabled: false`，角色缺 `diagnosis:read` 时回答 403；两种情况都不该
 * 露出一个点开只会报错的按钮。探测只做一次，切换 Trace 不再重复请求。
 */

import { ref, watch, type Ref } from 'vue';
import { bffClient } from '@/api/client';

export function useDiagnosisGate(traceId: Ref<string | null>) {
  const enabled = ref(false);
  const open = ref(false);
  let probed = false;

  watch(traceId, (id) => {
    open.value = false;
    if (!id || probed) return;
    probed = true;
    void bffClient.diagnosis.status()
      .then((s) => { enabled.value = s.enabled; })
      .catch(() => { enabled.value = false; });
  }, { immediate: true });

  return { enabled, open };
}
