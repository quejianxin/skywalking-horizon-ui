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
 * 阿里云 SLS 风格的查询子集 → Elasticsearch DSL。
 *
 * 支持：
 *   全文 `timeout` / `"connection reset"`
 *   字段等值 `level:ERROR`
 *   通配 `service:order*`（禁止前导 `*`）
 *   正则 `message:/timeout|reset/`
 *   布尔 `level:ERROR AND NOT service:health`、`(a OR b) AND c`
 *
 * 解析失败抛出 {@link LogQuerySyntaxError}，带字符偏移；路由返回 400 并把
 * 偏移交给页面。生成的 DSL 只包含 query/filter 结构，不含脚本、聚合或任何
 * 写操作，资源上限由 {@link LIMITS} 约束。
 */

export const LIMITS = {
  queryChars: 2000,
  regexChars: 256,
  terms: 50,
  depth: 20,
  /** 与 `regexp` 查询一起下发的 Lucene 状态上限。 */
  maxDeterminizedStates: 10000,
} as const;

export class LogQuerySyntaxError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(message);
    this.name = 'LogQuerySyntaxError';
    this.position = position;
  }
}

export type LogQueryNode =
  | { kind: 'and'; children: LogQueryNode[] }
  | { kind: 'or'; children: LogQueryNode[] }
  | { kind: 'not'; child: LogQueryNode }
  | { kind: 'fulltext'; value: string; phrase: boolean }
  | { kind: 'term'; field: string; op: 'match' | 'phrase' | 'wildcard' | 'regexp'; value: string };

type TokenType = 'word' | 'string' | 'regex' | 'lparen' | 'rparen' | 'colon' | 'and' | 'or' | 'not' | 'eof';

interface Token {
  type: TokenType;
  text: string;
  pos: number;
}

const KEYWORDS: Record<string, TokenType> = { and: 'and', or: 'or', not: 'not' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') { tokens.push({ type: 'lparen', text: ch, pos: i++ }); continue; }
    if (ch === ')') { tokens.push({ type: 'rparen', text: ch, pos: i++ }); continue; }
    if (ch === ':') { tokens.push({ type: 'colon', text: ch, pos: i++ }); continue; }
    if (ch === '"') {
      const start = i;
      i++;
      let value = '';
      let closed = false;
      while (i < input.length) {
        const c = input[i]!;
        if (c === '\\' && i + 1 < input.length) {
          value += input[i + 1];
          i += 2;
          continue;
        }
        if (c === '"') { i++; closed = true; break; }
        value += c;
        i++;
      }
      if (!closed) throw new LogQuerySyntaxError('引号未闭合', start);
      tokens.push({ type: 'string', text: value, pos: start });
      continue;
    }
    if (ch === '/') {
      const start = i;
      i++;
      let value = '';
      let closed = false;
      while (i < input.length) {
        const c = input[i]!;
        if (c === '\\' && i + 1 < input.length) {
          value += c + input[i + 1];
          i += 2;
          continue;
        }
        if (c === '/') { i++; closed = true; break; }
        value += c;
        i++;
      }
      if (!closed) throw new LogQuerySyntaxError('正则未闭合', start);
      tokens.push({ type: 'regex', text: value, pos: start });
      continue;
    }
    const start = i;
    let word = '';
    while (i < input.length && !/[\s():]/.test(input[i]!)) {
      word += input[i];
      i++;
    }
    const keyword = KEYWORDS[word.toLowerCase()];
    tokens.push({ type: keyword ?? 'word', text: word, pos: start });
  }
  tokens.push({ type: 'eof', text: '', pos: input.length });
  return tokens;
}

/** ES 字段名；与数据源配置使用的是同一字符集，避免把 DSL 结构注入字段位。 */
const FIELD_PATTERN = /^[A-Za-z0-9_.@-]{1,200}$/;

function checkField(field: string, pos: number): string {
  if (!FIELD_PATTERN.test(field)) throw new LogQuerySyntaxError(`字段名不合法：${field}`, pos);
  return field;
}

function checkRegex(value: string, pos: number): string {
  if (value.length === 0) throw new LogQuerySyntaxError('正则不能为空', pos);
  if (value.length > LIMITS.regexChars) {
    throw new LogQuerySyntaxError(`正则长度不能超过 ${LIMITS.regexChars} 个字符`, pos);
  }
  if (value.startsWith('*') || value.startsWith('.*')) {
    throw new LogQuerySyntaxError('正则不能以 * 或 .* 开头', pos);
  }
  return value;
}

function checkWildcard(value: string, pos: number): string {
  if (value.startsWith('*')) throw new LogQuerySyntaxError('通配符不能以 * 开头', pos);
  return value;
}

class Parser {
  private index = 0;
  private terms = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): LogQueryNode {
    const node = this.parseOr(0);
    this.expect('eof', '查询末尾有多余内容');
    return node;
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private take(type: TokenType, message: string): Token {
    const token = this.peek();
    if (token.type !== type) throw new LogQuerySyntaxError(message, token.pos);
    this.index++;
    return token;
  }

  private expect(type: TokenType, message: string): void {
    this.take(type, message);
  }

  private countTerm(pos: number): void {
    this.terms++;
    if (this.terms > LIMITS.terms) {
      throw new LogQuerySyntaxError(`查询条件不能超过 ${LIMITS.terms} 个`, pos);
    }
  }

  private parseOr(depth: number): LogQueryNode {
    const children = [this.parseAnd(depth)];
    while (this.peek().type === 'or') {
      this.index++;
      children.push(this.parseAnd(depth));
    }
    return children.length === 1 ? children[0]! : { kind: 'or', children };
  }

  /** 显式 AND 与空白并列都按 AND 处理；`OR` / `)` / 末尾结束当前层。 */
  private parseAnd(depth: number): LogQueryNode {
    const children = [this.parseUnary(depth)];
    for (;;) {
      const next = this.peek().type;
      if (next === 'and') {
        this.index++;
        children.push(this.parseUnary(depth));
        continue;
      }
      if (next === 'word' || next === 'string' || next === 'regex' || next === 'lparen' || next === 'not') {
        children.push(this.parseUnary(depth));
        continue;
      }
      break;
    }
    return children.length === 1 ? children[0]! : { kind: 'and', children };
  }

  private parseUnary(depth: number): LogQueryNode {
    if (depth >= LIMITS.depth) {
      throw new LogQuerySyntaxError(`括号嵌套不能超过 ${LIMITS.depth} 层`, this.peek().pos);
    }
    const token = this.peek();
    if (token.type === 'not') {
      this.index++;
      return { kind: 'not', child: this.parseUnary(depth + 1) };
    }
    if (token.type === 'lparen') {
      this.index++;
      const node = this.parseOr(depth + 1);
      this.take('rparen', '缺少右括号');
      return node;
    }
    if (token.type === 'regex') {
      throw new LogQuerySyntaxError('正则必须指定字段，例如 message:/timeout/', token.pos);
    }
    if (token.type === 'string') {
      this.index++;
      this.countTerm(token.pos);
      return { kind: 'fulltext', value: token.text, phrase: true };
    }
    if (token.type !== 'word') {
      throw new LogQuerySyntaxError('此处需要一个查询条件', token.pos);
    }
    this.index++;
    if (this.peek().type === 'colon') {
      this.index++;
      return this.parseFieldValue(checkField(token.text, token.pos), token.pos);
    }
    this.countTerm(token.pos);
    return { kind: 'fulltext', value: token.text, phrase: false };
  }

  private parseFieldValue(field: string, pos: number): LogQueryNode {
    const value = this.peek();
    if (value.type === 'string') {
      this.index++;
      this.countTerm(pos);
      return { kind: 'term', field, op: 'phrase', value: value.text };
    }
    if (value.type === 'regex') {
      this.index++;
      this.countTerm(pos);
      return { kind: 'term', field, op: 'regexp', value: checkRegex(value.text, value.pos) };
    }
    if (value.type === 'word') {
      this.index++;
      this.countTerm(pos);
      const wildcard = value.text.includes('*') || value.text.includes('?');
      return {
        kind: 'term',
        field,
        op: wildcard ? 'wildcard' : 'match',
        value: wildcard ? checkWildcard(value.text, value.pos) : value.text,
      };
    }
    throw new LogQuerySyntaxError(`字段 ${field} 缺少值`, value.pos);
  }
}

/** 解析一条 SLS 子集查询；空串返回 `null`（等价于 match_all）。 */
export function parseLogQuery(input: string): LogQueryNode | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  if (trimmed.length > LIMITS.queryChars) {
    throw new LogQuerySyntaxError(`查询长度不能超过 ${LIMITS.queryChars} 个字符`, 0);
  }
  return new Parser(lex(trimmed)).parse();
}

export interface EsQuery {
  query: Record<string, unknown>;
}

function fulltextQuery(value: string, phrase: boolean, messageFields: readonly string[]): Record<string, unknown> {
  const fields = messageFields.length > 0 ? [...messageFields] : ['*'];
  return phrase
    ? { multi_match: { query: value, fields, type: 'phrase' } }
    : { multi_match: { query: value, fields, operator: 'and' } };
}

/** 把解析结果转成 ES query 子句。`messageFields` 为空时全文走 `fields: ['*']`。 */
export function toEsQuery(node: LogQueryNode, messageFields: readonly string[]): Record<string, unknown> {
  switch (node.kind) {
    case 'and':
      return { bool: { filter: node.children.map((child) => toEsQuery(child, messageFields)) } };
    case 'or':
      return {
        bool: {
          should: node.children.map((child) => toEsQuery(child, messageFields)),
          minimum_should_match: 1,
        },
      };
    case 'not':
      return { bool: { must_not: [toEsQuery(node.child, messageFields)] } };
    case 'fulltext':
      return fulltextQuery(node.value, node.phrase, messageFields);
    case 'term':
      switch (node.op) {
        case 'regexp':
          return { regexp: { [node.field]: { value: node.value, max_determinized_states: LIMITS.maxDeterminizedStates } } };
        case 'wildcard':
          return { wildcard: { [node.field]: { value: node.value } } };
        case 'phrase':
          return { match_phrase: { [node.field]: node.value } };
        default:
          return { match: { [node.field]: node.value } };
      }
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}
