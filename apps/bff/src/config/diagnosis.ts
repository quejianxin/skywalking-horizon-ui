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

import { z } from 'zod';

/**
 * 诊断服务：在 SkyWalking Trace 之上补规则判定、SQL 模板聚合、锁等待、异步
 * 时段与线程归因。Trace 本身仍来自 OAP，这里只承接 OAP 协议之外、需要跨
 * Span 推断的结论。
 *
 * `url` 留空表示未部署该服务，Horizon 隐藏 Trace 详情里的诊断入口；`token`
 * 是 SECRET，只在服务端使用，不返回浏览器、不写日志。
 */
export const diagnosisSchema = z
  .object({
    url: z
      .string()
      .trim()
      .default('')
      .refine((v) => v === '' || /^https?:\/\//i.test(v), {
        message: 'must be an http(s) URL, or empty to disable diagnosis',
      }),
    token: z.string().default(''),
    timeoutMs: z.number().int().positive().default(15000),
  })
  .strict()
  .default({});
