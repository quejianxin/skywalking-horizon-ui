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

import { graphqlPost, type GraphqlOptions } from './graphql.js';
import type { LinkSpan } from '../logs/types.js';

// 串联仅需摘要字段，不读取 Span 标签、附带日志和事件。
const QUERY_LOG_LINK = /* GraphQL */ `
  query QueryLogLink($traceId: ID!) {
    trace: queryTrace(traceId: $traceId) {
      spans { serviceCode startTime endTime endpointName type peer component isError layer }
    }
  }
`;

export async function fetchLogLinkSpans(opts: GraphqlOptions, traceId: string): Promise<LinkSpan[]> {
  const result = await graphqlPost<{ trace: { spans: LinkSpan[] } | null }>(opts, QUERY_LOG_LINK, { traceId });
  if (result.trace === null) return [];
  if (!Array.isArray(result.trace?.spans)) throw new Error('OAP 未返回合法的 Span 列表');
  return result.trace.spans;
}
