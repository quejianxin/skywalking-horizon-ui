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
 * AI 助手管理设置接口。
 *   GET /api/admin/ai-settings — 生效配置（不含密钥明文）
 *   PUT /api/admin/ai-settings — 保存并立即生效
 *
 * 路由由 RBAC 策略表以 `ai-settings:read` / `ai-settings:write` 盖住；
 * 读取接口只报告密钥是否已配置，写接口永不回显提交的密钥。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';
import {
  AiSettingsNotWritableError,
  aiSettingsInputSchema,
  type AiSettingsStore,
} from '../../ai/settings.js';
import { AiConfigError } from '../../ai/model-outbound.js';
import { logger } from '../../logger.js';

export interface AiSettingsRouteDeps extends AuthDeps {
  settings: AiSettingsStore;
}

export function registerAiSettingsAdminRoutes(app: FastifyInstance, deps: AiSettingsRouteDeps): void {
  const auth = requireAuth(deps);

  app.get(
    '/api/admin/ai-settings',
    { preHandler: auth },
    async (_req: FastifyRequest, reply: FastifyReply) => reply.send(deps.settings.view()),
  );

  app.put(
    '/api/admin/ai-settings',
    { preHandler: auth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = aiSettingsInputSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          code: 'BAD_AI_SETTINGS',
          message: 'AI 设置校验失败',
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }
      try {
        const view = deps.settings.save(parsed.data);
        logger.info(
          {
            enabled: view.enabled,
            provider: view.provider,
            model: view.model,
            ready: view.ready,
            // 只记录是否配置了密钥，绝不记录内容。
            hasApiKey: view.hasApiKey,
          },
          'AI 设置已更新',
        );
        return reply.send(view);
      } catch (err) {
        if (err instanceof AiSettingsNotWritableError) {
          return reply.code(409).send({ code: 'AI_SETTINGS_READONLY', message: err.message });
        }
        if (err instanceof AiConfigError) {
          return reply.code(400).send({
            code: 'BAD_AI_SETTINGS',
            message: err.message,
            details: [{ path: err.field, message: err.message }],
          });
        }
        throw err;
      }
    },
  );
}
