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
 * 日志数据源管理接口：`/api/admin/log-sources`。
 *
 * 读用 `log-source:read`，写用 `log-source:write`；连接测试会用到已存凭据，
 * 因此同样归入写权限。凭据只进不出——响应里只有 `hasCredential`。
 */

import { clientGone } from '../client-gone.js';
import { runtimeOf } from '../../logic/log-search/search.js';
import type { FastifyInstance } from 'fastify';
import type { ZodIssue } from 'zod';
import { z } from 'zod';
import { EsHttpError, esClusterHealth, esProbe } from '../../client/elasticsearch.js';
import { logger } from '../../logger.js';
import { LogSourceConfigurationError, LogSourceNotFoundError, LogSourceNotWritableError, logSourceInputSchema } from '../../logs/sources.js';
import type { LogSourceInput } from '../../logs/sources.js';
import type { LogSourceList, LogSourceRecord, LogSourceView } from '../../logs/types.js';
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';

export interface LogSourcesAdminDeps extends AuthDeps {
  store: {
    readonly writable: boolean;
    list(): LogSourceView[];
    runtime(id: string): LogSourceRecord;
    create(input: LogSourceInput): LogSourceView;
    update(id: string, input: LogSourceInput): LogSourceView;
    remove(id: string): void;
  };
}

const idParams = z.object({ id: z.string().uuid() });

function detailsOf(issues: ZodIssue[]): Array<{ path: string; message: string }> {
  return issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

export function registerLogSourcesAdminRoutes(app: FastifyInstance, deps: LogSourcesAdminDeps): void {
  const { store } = deps;
  // verb 由 ROUTE_POLICY 在全局钩子中盖住，这里只负责认证与会话续期。
  const auth = requireAuth(deps);

  app.get('/api/admin/log-sources', { preHandler: auth }, async (): Promise<LogSourceList> => ({
    writable: store.writable,
    sources: store.list(),
  }));

  app.post('/api/admin/log-sources', { preHandler: auth }, async (req, reply) => {
    const parsed = logSourceInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'BAD_LOG_SOURCE',
        message: '日志数据源字段不合法',
        details: detailsOf(parsed.error.issues),
      });
    }
    try {
      return reply.code(201).send(store.create(parsed.data));
    } catch (err) {
      return replyToStoreError(err, reply);
    }
  });

  app.put('/api/admin/log-sources/:id', { preHandler: auth }, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ code: 'BAD_LOG_SOURCE', message: '数据源 ID 不合法' });
    const parsed = logSourceInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'BAD_LOG_SOURCE',
        message: '日志数据源字段不合法',
        details: detailsOf(parsed.error.issues),
      });
    }
    try {
      return store.update(params.data.id, parsed.data);
    } catch (err) {
      return replyToStoreError(err, reply);
    }
  });

  app.delete('/api/admin/log-sources/:id', { preHandler: auth }, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ code: 'BAD_LOG_SOURCE', message: '数据源 ID 不合法' });
    try {
      store.remove(params.data.id);
      return reply.code(204).send();
    } catch (err) {
      return replyToStoreError(err, reply);
    }
  });

  app.post('/api/admin/log-sources/:id/test', { preHandler: auth }, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ code: 'BAD_LOG_SOURCE', message: '数据源 ID 不合法' });
    let record: LogSourceRecord;
    try {
      record = store.runtime(params.data.id);
    } catch (err) {
      return replyToStoreError(err, reply);
    }
    const runtime = runtimeOf(record);
    const signal = clientGone(reply);
    const startedAt = Date.now();
    try {
      const probe = await esProbe(runtime, { signal });
      const health = await esClusterHealth(runtime, { signal }).catch(() => null);
      return {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        cluster: health?.cluster_name ?? null,
        status: health?.status ?? null,
        nodes: health?.number_of_nodes ?? null,
        sampled: probe.hits.hits.length,
      };
    } catch (err) {
      const message = err instanceof EsHttpError ? err.message : 'Elasticsearch 连接测试未完成';
      logger.warn(`日志数据源连接测试失败（${record.id}）：${message}`);
      return reply.code(502).send({
        code: 'LOG_SOURCE_UNREACHABLE',
        message,
        elapsedMs: Date.now() - startedAt,
      });
    }
  });
}

function replyToStoreError(err: unknown, reply: { code(status: number): { send(payload: unknown): unknown } }): unknown {
  if (err instanceof LogSourceConfigurationError) {
    return reply.code(400).send({ code: 'BAD_LOG_SOURCE', message: err.message });
  }
  if (err instanceof LogSourceNotWritableError) {
    return reply.code(409).send({ code: 'LOG_SOURCES_READONLY', message: err.message });
  }
  if (err instanceof LogSourceNotFoundError) {
    return reply.code(404).send({ code: 'LOG_SOURCE_NOT_FOUND', message: err.message });
  }
  throw err;
}
