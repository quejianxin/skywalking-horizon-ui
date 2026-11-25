# Runtime State Files

Horizon 自动管理运行时文件，不需要手工编辑。日志数据源和 AI 设置如需在重建容器后保留，应将对应文件放在持久卷中。

## `debugLog.file`

| Field | Type | Default | Required | Notes |
|---|---|---|---|---|
| `debugLog.file` | string | `./horizon-wire.jsonl` | no | Filesystem path to the OAP wire debug log. Only written when `debugLog.enabled` is set. |

The OAP request/response wire trace, off by default. See [Debug Log](debug-log.md).

## Env-var fallback

When `horizon.yaml` does not supply `debugLog.file`, the default is seeded from an env var:

| YAML key | Env-var fallback | Default |
|---|---|---|
| `debugLog.file` | `HORIZON_WIRE_LOG_FILE` | `./horizon-wire.jsonl` |

The published Docker image sets this env var to a `/data/...` path so an operator who runs the image without a `horizon.yaml` override gets writes routed to the declared `/data` volume — see [Container Image → Persisting the wire debug log](container-image.md#persisting-the-wire-debug-log). An explicit value in `horizon.yaml` always wins over the env-var fallback.

## `HORIZON_LOG_SOURCES_FILE`

指定 Horizon 持久化 Elasticsearch 日志数据源及其凭据的文件路径。例如，在将持久卷挂载到 `/data` 的容器中，可设置为 `/data/log-sources.json`。确保 Horizon 对父目录可写；文件须为权限 `0600` 的普通文件，不支持符号链接。未设置此变量时，数据源管理页只读，日志检索没有可选的数据源。请通过[日志数据源管理页](../operate/log-search.md)维护配置，不要提交文件或将其放入镜像。

AI 设置文件的配置与权限规则见 [AI 助手](../operate/ai-assistant.md)。

## `HORIZON_LOG_SOURCES_ALLOWED_BASE_URLS`

逗号分隔的 Elasticsearch 基础地址，启动时读取，默认不放行任何地址。按完整地址精确匹配，包括协议、端口及路径；末尾斜杠归一化，不接受通配符、URL 凭据、查询参数、片段或重定向。修改名单后须重新启动 Horizon；移除地址后，旧配置仍可管理，但不能测试连接或检索。对于需要 Basic 或 API key 的数据源，必须使用启用证书校验的 HTTPS。

## Operational notes

- **This is mutable runtime state.** It should be on durable storage, not a container tmpfs, if you want it to survive a restart.
- **It is gitignored by default** (see `.gitignore`). It is not source-controlled; it is operational state.
- **Appends are atomic.** The log is append-only, so a crash mid-write cannot corrupt earlier records.
- **It is a debugging aid, not a security record.** It captures OAP request and response payloads when switched on, and it is off by default because those payloads are large and can carry data you would not want at rest. For a record of who signed in, read the application log; Horizon keeps no record of who changed what.
