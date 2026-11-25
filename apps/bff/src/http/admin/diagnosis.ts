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
 * `/api/diagnosis*` — 诊断服务在 Horizon 里的唯一入口。
 *
 *   GET /api/diagnosis/status              — 是否已部署诊断服务
 *   GET /api/diagnosis/traces/:traceId     — 一个 Trace 的完整诊断
 *
 * Trace 列表、瀑布、日志、拓扑与告警仍由 SkyWalking 原生页面提供；这里
 * 只补 OAP 协议没有的推断，因此入口挂在 Trace 详情里，而不是另开一套
 * 管理台。令牌只在服务端使用，状态接口只报告是否配置，不回显任何配置值。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import { clientGone } from '../client-gone.js';
import {
  DiagnosisHttpError,
  isDiagnosisConfigured,
  isValidDiagnosisTraceId,
  readTraceDiagnosis,
} from '../../client/diag.js';

export interface DiagnosisRouteDeps extends AuthDeps {
  fetch?: FetchLike;
}

export function registerDiagnosisRoutes(app: FastifyInstance, deps: DiagnosisRouteDeps): void {
  const auth = requireAuth(deps);

  app.get(
    '/api/diagnosis/status',
    { preHandler: auth },
    async (_req: FastifyRequest, reply: FastifyReply) =>
      reply.send({ enabled: isDiagnosisConfigured(deps.config.current.diagnosis) }),
  );

  app.get<{ Params: { traceId: string } }>(
    '/api/diagnosis/traces/:traceId',
    { preHandler: auth },
    async (req: FastifyRequest<{ Params: { traceId: string } }>, reply: FastifyReply) => {
      const { traceId } = req.params;
      if (!isValidDiagnosisTraceId(traceId)) {
        return reply.code(400).send({
          code: 'BAD_TRACE_ID',
          message: 'Trace ID 格式不合法',
        });
      }
      const cfg = deps.config.current.diagnosis;
      if (!isDiagnosisConfigured(cfg)) {
        return reply.code(503).send({
          code: 'DIAGNOSIS_NOT_CONFIGURED',
          message: '诊断服务未部署：请由部署方设置 HORIZON_DIAG_URL 后重启 Horizon。',
        });
      }
      try {
        return reply.send(
          await readTraceDiagnosis(cfg, traceId, { fetch: deps.fetch, signal: clientGone(reply) }),
        );
      } catch (err) {
        if (!(err instanceof DiagnosisHttpError)) throw err;
        if (err.status === 401 || err.status === 403) {
          return reply.code(502).send({
            code: 'DIAGNOSIS_AUTH_FAILED',
            message: '诊断服务拒绝了请求：请检查 HORIZON_DIAG_TOKEN 是否与服务端令牌一致。',
          });
        }
        return reply.code(502).send({
          code: err.status === 0 ? 'DIAGNOSIS_UNREACHABLE' : 'DIAGNOSIS_FAILED',
          message:
            err.status === 0
              ? '诊断服务不可达：请确认服务已启动、地址正确，并与 Horizon 在同一网络内。'
              : '诊断服务返回错误，未能读取该 Trace 的诊断结果。',
          details: { upstreamStatus: err.status },
        });
      }
    },
  );
}
