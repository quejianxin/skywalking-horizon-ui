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

import { describe, expect, it } from 'vitest';
import { LIMITS, LogQuerySyntaxError, parseLogQuery, toEsQuery } from './query.js';

const MESSAGE_FIELDS = ['message', 'msg'];

function es(input: string): Record<string, unknown> {
  const node = parseLogQuery(input);
  return node ? toEsQuery(node, MESSAGE_FIELDS) : { match_all: {} };
}

function expectError(input: string, message: string, position?: number): void {
  try {
    parseLogQuery(input);
  } catch (err) {
    expect(err).toBeInstanceOf(LogQuerySyntaxError);
    expect((err as LogQuerySyntaxError).message).toContain(message);
    if (position !== undefined) expect((err as LogQuerySyntaxError).position).toBe(position);
    return;
  }
  throw new Error(`应当解析失败：${input}`);
}

describe('SLS 子集解析', () => {
  it('空查询返回 null', () => {
    expect(parseLogQuery('   ')).toBeNull();
  });

  it('全文走多字段匹配，引号短语走 phrase', () => {
    expect(es('timeout')).toEqual({ multi_match: { query: 'timeout', fields: MESSAGE_FIELDS, operator: 'and' } });
    expect(es('"connection reset"')).toEqual({
      multi_match: { query: 'connection reset', fields: MESSAGE_FIELDS, type: 'phrase' },
    });
  });

  it('字段等值、短语、通配与正则', () => {
    expect(es('level:ERROR')).toEqual({ match: { level: 'ERROR' } });
    expect(es('message:"order failed"')).toEqual({ match_phrase: { message: 'order failed' } });
    expect(es('service:order*')).toEqual({ wildcard: { service: { value: 'order*' } } });
    expect(es('message:/timeout|reset/')).toEqual({
      regexp: { message: { value: 'timeout|reset', max_determinized_states: LIMITS.maxDeterminizedStates } },
    });
  });

  it('空白与 AND 都是 AND，OR 与括号按层级组合', () => {
    expect(es('level:ERROR timeout')).toEqual({
      bool: { filter: [{ match: { level: 'ERROR' } }, { multi_match: { query: 'timeout', fields: MESSAGE_FIELDS, operator: 'and' } }] },
    });
    expect(es('level:ERROR AND NOT service:health')).toEqual({
      bool: {
        filter: [
          { match: { level: 'ERROR' } },
          { bool: { must_not: [{ match: { service: 'health' } }] } },
        ],
      },
    });
    expect(es('(a OR b) AND c')).toEqual({
      bool: {
        filter: [
          { bool: { should: [{ multi_match: { query: 'a', fields: MESSAGE_FIELDS, operator: 'and' } }, { multi_match: { query: 'b', fields: MESSAGE_FIELDS, operator: 'and' } }], minimum_should_match: 1 } },
          { multi_match: { query: 'c', fields: MESSAGE_FIELDS, operator: 'and' } },
        ],
      },
    });
  });

  it('没有配置内容字段时全文用 *', () => {
    const node = parseLogQuery('timeout');
    expect(toEsQuery(node!, [])).toEqual({ multi_match: { query: 'timeout', fields: ['*'], operator: 'and' } });
  });

  it('转义引号保留在值里', () => {
    expect(es('message:"say \\"hi\\""')).toEqual({ match_phrase: { message: 'say "hi"' } });
  });
});

describe('SLS 子集的安全上限与报错位置', () => {
  it('引号与正则未闭合', () => {
    expectError('message:"abc', '引号未闭合', 8);
    expectError('message:/abc', '正则未闭合', 8);
  });

  it('裸正则必须带字段', () => {
    expectError('/timeout/', '正则必须指定字段');
  });

  it('禁止前导通配与正则前导 .*', () => {
    expectError('service:*order', '通配符不能以 * 开头');
    expectError('message:/.*timeout/', '正则不能以 * 或 .* 开头');
  });

  it('正则超长被拒绝', () => {
    expectError(`message:/${'a'.repeat(LIMITS.regexChars + 1)}/`, '正则长度');
  });

  it('括号不匹配、缺少值、末尾多余内容', () => {
    expectError('(a OR b', '缺少右括号');
    expectError('level:', '缺少值');
    expectError('a )', '多余内容');
  });

  it('嵌套与条件数量有上限', () => {
    expectError('('.repeat(LIMITS.depth + 1) + 'a' + ')'.repeat(LIMITS.depth + 1), '嵌套');
    const tooMany = Array.from({ length: LIMITS.terms + 1 }, (_, i) => `w${i}`).join(' ');
    expectError(tooMany, `不能超过 ${LIMITS.terms}`);
  });

  it('字段名不能注入 DSL 结构', () => {
    expectError('"abc', '引号未闭合', 0);
    expectError('bad!field:x', '字段名不合法');
  });

  it('超长查询整体被拒绝', () => {
    expectError('a'.repeat(LIMITS.queryChars + 1), '查询长度');
  });
});
