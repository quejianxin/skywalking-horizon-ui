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
 * Elasticsearch 日志检索与日志串联链路。
 *
 *   GET  /api/logs/sources     — 检索页的数据源下拉（只有 id / 名称 / 索引）
 *   POST /api/logs/search      — SLS 子集语法检索一个数据源
 *   POST /api/logs/trace-link  — 同上，并把日志自带的 traceId 串到 OAP Span
 *
 * 三个接口都需要全局 `logs:read`；串联还需要全局 `traces:read`。
 * 数据源列表只给检索必需的三个字段：持有 `logs:read` 不等于能看数据源地址与
 * 字段映射，那是 `log-source:read` 管理面的内容。
 * 每次查询记一条 info 日志：用户、数据源、耗时、命中数——不记查询语句本身。
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { FetchLike } from '@skywalking-horizon-ui/api-client';
import { buildOapOpts } from '../../client/graphql.js';
import { clientGone } from '../client-gone.js';
import { logger } from '../../logger.js';
import { LogQuerySyntaxError, LIMITS } from '../../logs/query.js';
import {
  LogSourceNotFoundError,
  LogSourceConfigurationError,
  type LogSourceStore,
} from '../../logs/sources.js';
import type { LogSearchRequest, LogSearchSourceList, LogSourceRecord } from '../../logs/types.js';
import { LogSearchPageError, LogSearchRangeError, runLogSearch } from '../../logic/log-search/search.js';
import { runTraceLink } from '../../logic/log-search/trace-link.js';
import { fetchLogLinkSpans } from '../../client/log-link-trace.js';
import { isLinkableTraceId, MAX_LOG_PAGE_SIZE } from '../../logs/types.js';
import { sessionHasVerb } from '../../rbac/policy.js';
import type { AuthDeps } from '../../user/middleware.js';
import { requireAuth } from '../../user/middleware.js';

const searchBody = z
  .object({
    sourceId: z.string().uuid(),
    query: z.string().max(LIMITS.queryChars).optional(),
    startMs: z.number().int().nonnegative().optional(),
    endMs: z.number().int().nonnegative().optional(),
    windowMinutes: z.number().int().min(1).max(10_080).optional(),
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(MAX_LOG_PAGE_SIZE).optional(),
    sort: z.enum(['asc', 'desc']).optional(),
  })
  .strict();

const linkBody = z.object({
  rowTraceIds: z.array(z.string().refine(isLinkableTraceId).nullable()).max(MAX_LOG_PAGE_SIZE),
}).strict();

export interface LogSearchRouteDeps extends AuthDeps {
  store: Pick<LogSourceStore, 'runtime' | 'list'>;
  fetch?: FetchLike;
}

function badQuery(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof LogQuerySyntaxError) {
    return reply.code(400).send({ code: 'BAD_LOG_QUERY', message: err.message, position: err.position });
  }
  if (err instanceof LogSearchRangeError || err instanceof LogSearchPageError) {
    return reply.code(400).send({ code: 'BAD_LOG_QUERY', message: err.message });
  }
  throw err;
}

/** 检索参数与数据源校验在发起请求前完成。 */
function resolveRequest(
  body: unknown,
  store: Pick<LogSourceStore, 'runtime'>,
  reply: FastifyReply,
): { record: LogSourceRecord; request: LogSearchRequest } | null {
  const parsed = searchBody.safeParse(body ?? {});
  if (!parsed.success) {
    reply.code(400).send({
      code: 'BAD_LOG_QUERY',
      message: '检索参数不合法',
      details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
    return null;
  }
  try {
    return { record: store.runtime(parsed.data.sourceId), request: parsed.data };
  } catch (err) {
    if (err instanceof LogSourceConfigurationError) {
      reply.code(400).send({ code: 'BAD_LOG_SOURCE', message: err.message });
      return null;
    }
    if (!(err instanceof LogSourceNotFoundError)) throw err;
    reply.code(404).send({ code: 'LOG_SOURCE_NOT_FOUND', message: err.message });
    return null;
  }
}

export function registerLogSearchRoutes(app: FastifyInstance, deps: LogSearchRouteDeps): void {
  const auth = requireAuth(deps);

  app.get('/api/logs/sources', { preHandler: auth }, async (): Promise<LogSearchSourceList> => ({
    sources: deps.store.list().map((source) => ({ id: source.id, name: source.name, index: source.index })),
  }));

  app.post('/api/logs/search', { preHandler: auth }, async (req, reply) => {
    const resolved = resolveRequest(req.body, deps.store, reply);
    if (!resolved) return reply;
    const signal = clientGone(reply);
    try {
      const result = await runLogSearch(resolved.record, resolved.request, {
        fetch: deps.fetch,
        signal,
      });
      logger.info(
        `日志检索 user=${req.session?.username ?? '-'} source=${resolved.record.id} `
        + `rows=${result.logs.length} total=${result.total} tookMs=${result.tookMs} reachable=${result.reachable}`,
      );
      return reply.send(result);
    } catch (err) {
      return badQuery(reply, err);
    }
  });

  app.post('/api/logs/trace-link', { preHandler: auth }, async (req, reply) => {
    // 两个权限都必须是全局授权，不能用其中一个全局授权补齐另一个的 layer/group 限制。
    for (const verb of ['logs:read', 'traces:read'] as const) {
      if (!req.session || !sessionHasVerb(deps.config.current, req.session, verb)) {
        return reply.code(403).send({ error: 'permission_denied', verb, reason: 'not_attributable_to_a_service' });
      }
    }
    const parsed = linkBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ code: 'BAD_LOG_QUERY', message: '本页 Trace ID 不合法' });
    const signal = clientGone(reply);
    const oap = buildOapOpts(deps.config.current, deps.fetch, signal);
    const result = await runTraceLink(parsed.data.rowTraceIds, {
      signal,
      spanFetcher: (traceId) => fetchLogLinkSpans(oap, traceId),
    });
    logger.info(
      `日志串联 user=${req.session?.username ?? '-'} logs=${parsed.data.rowTraceIds.length} `
      + `linked=${result.linkedCount} failed=${result.failedTraceCount} skipped=${result.skippedTraceCount}`,
    );
    return reply.send(result);
  });
}
