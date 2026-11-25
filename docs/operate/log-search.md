<!--
Licensed to the Apache Software Foundation (ASF) under one or more
contributor license agreements.  See the NOTICE file distributed with
this work for additional information regarding copyright ownership.
The ASF licenses this file to You under the Apache License, Version 2.0
(the "License"); you may not use this file except in compliance with
the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# 日志检索（Log search）

**Log search**（`/logs`）搜索已配置的 Elasticsearch 索引，并可用日志里的 `traceId` 查找 OAP 中的 Trace。该页面不会采集或写入日志；SkyWalking 自己采集的日志仍在 [Logs](logs.md) 和 [Log Inspect](log-inspect.md) 中查询。

## 配置日志数据源

先由部署方通过 [`HORIZON_LOG_SOURCES_ALLOWED_BASE_URLS`](../setup/files.md) 批准 Elasticsearch 地址，再用有权限的账号打开 **管理 → Log sources**（`/admin/log-sources`），点击 **Add**，填写并保存：

| 设置 | 填写方式 |
|---|---|
| 名称和地址 | 填写便于识别的名称，以及从 Horizon 运行环境可达的 Elasticsearch HTTP(S) 基础地址。不要在 URL 中填写凭据、查询参数或片段；容器内的 `127.0.0.1` 指向容器自身。 |
| 索引模式 | 填写具体索引或受限模式，例如 `app-logs-*`。为查询账号只授予所需索引的只读权限。 |
| 时间字段 | 默认为 `@timestamp`，应映射为 Elasticsearch 日期字段。 |
| 认证与 TLS | 按部署选择无认证、Basic 或 API key。Basic 和 API key 必须使用启用证书校验的 HTTPS；只在隔离的无认证测试环境使用 HTTP。 |
| Trace ID / 消息字段 | 按优先顺序填写字段名。默认 Trace ID 字段为 `traceId`、`trace_id`，消息字段为 `message`、`msg`、`content`。 |
| 查询限制 | 可配置默认时间窗口和每页最大行数。 |

保存后点击 **Test** 检查索引能否读取。集群健康权限不是查询所必需；缺少时只显示索引抽检结果。凭据不会回显；基础地址、认证方式、用户名和 TLS 设置均未变时，留空沿用原凭据。若页面只读，请检查当前角色权限及部署是否配置了 [`HORIZON_LOG_SOURCES_FILE`](../setup/files.md)。

## 执行查询

选择数据源、时间窗口和排序后点击 **Search**。时间窗口最长 7 天，与全局时间选择器独立。查询框留空时按时间窗口检索。查询框支持 SLS 的常用表达式子集，不支持完整 SLS 或 SQL 管道。

| 写法 | 示例 |
|---|---|
| 全文或短语 | `timeout`、`"connection reset"` |
| 按字段筛选 | `level:ERROR` |
| 通配符 | `service:order-*`；不支持前导 `*` |
| 字段正则 | `message:/timeout\|reset/`；不支持以前导 `*` 或 `.*` 开头的表达式 |
| 组合条件 | `level:ERROR AND (timeout OR reset) AND NOT health`；相邻条件也可省略 `AND` |

语法错误会标出问题所在位置。结果表显示当前页日志，**Fields on this page** 只统计已加载的当前页，不代表索引字段清单。每页行数受数据源上限约束；最多翻到第 50 页，结果窗口也不超过 10,000 条。翻页沿用最近一次提交的条件和时间范围。看到截断提示时请缩短时间窗口或收紧条件：显示的日志不保证是完整结果或最新的若干条。

## 关联 Trace

在结果上点击 **Link traces**。系统按当前页最多 50 个不同的 Trace ID 查询同一 Horizon 配置的 OAP，并按 MQ、数据库、RPC、HTTP 分组展示找到的调用。页面将没有可用 ID 的日志行，与 OAP 未找到、读取失败、超过上限未查询的不同 Trace ID 分开统计。关联按 ID 使用 OAP 的默认存储阶段（BanyanDB 的热/温数据），不跟随全局 Cold 开关。找不到时，请核对环境、链路保留期限和存储阶段；也可在原生 Trace 页选择对应的存储阶段查询。

## 权限与排障

- 日志检索需要不带 layer 或 group 限定的 `logs:read`。已授权用户可以查询所有配置的数据源，不能按服务或 layer 限制该权限；不要在同一个部署中放入需要彼此隔离的数据源。关联及打开 Trace 还需要不带限定的 `traces:read`。
- 查看数据源需要 `log-source:read`；新增、修改、测试或移除另需 `log-source:write`。普通通配符不包含这些管理权限，详见 [RBAC](../access-control/rbac.md)。
- 连接失败时，检查部署名单及 Horizon 到 Elasticsearch 的网络、证书、认证和索引权限。服务返回重定向时，请将最终地址加入名单并填写到数据源。能查询但没有日志时，再检查索引模式、时间字段和时间窗口。
