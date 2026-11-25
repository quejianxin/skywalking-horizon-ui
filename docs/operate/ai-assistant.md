# AI Assistant

The AI Assistant is an in-app chat that answers questions about your system in plain language. It reads **live data from your OAP backend** through the same query path the dashboards use, and streams back an ordered narrative with **inline figures — line charts, single-value cards, top-N lists, tables and record lists — drawn by the same widgets** you see across the UI (grouped into tabs, a stack or a grid when an answer needs several). It can also embed the real feature views inline — not just text: the dependency graphs (**topology, whole-layer map, hierarchy, deployment, instance map, API dependency**), the **trace, log and browser-error** explorers, and **profiling** results (the flame graph, the network process graph). Every one of those blocks is a snapshot captured when the assistant read the data, so an answer keeps showing the evidence behind it. It is **read-only** and **off by default**.

**Prefer your own agent?** The same tools are available over the Model Context Protocol, so Claude Code, Codex or any MCP client can run these investigations from its own window — with the model on your side rather than one Horizon is configured with. See [MCP — connect your own agent](mcp.md).

## What it can do

- Answer investigative questions — "what's unhealthy right now?", "investigate latency for a service", "which services have the most errors?", "break a service down by its slowest endpoints".
- Read active **alarms** (the health signal), list layers and services (naming a service is enough — it searches every layer to find it), browse the per-layer **metric catalog** (the curated MQE behind each metric), drill a service down to its instances or endpoints, and render any of those metrics as a figure. Kubernetes layers — **K8S** (cluster / node) and **K8S_SERVICE** (service / pod) — read through this same catalog like any other layer.
- Draw a service's dependencies inline — a focused **topology** graph around one service or several named together (what calls them and what they call, two hops out by default) you can zoom, fit and filter in place, or the **whole-layer map** when the question is about the shape of a system rather than one service, and its **cross-layer hierarchy** (the same Smartscape fan as the topology page, projecting the service up and down into its mesh / infra / database layers). Both need your `topology:read` permission.
- Draw the deeper topology views inline too, each the real page focused for you (all `topology:read`): the **Deployment** graph — one service's own instances and how they call each other; the **Instance map** for a **source → destination** service pair — the instances of each and the calls between them (name both services in your question); and the **API dependency** chain — a named endpoint, or the service's busiest one, with its upstream/downstream callers/callees, where you can expand any node. Each keeps its pan/zoom and its node/edge detail, exactly as on the layer tab.
- Show a service's **traces** inline — the trace list it read, and on a row click that trace's span **waterfall**, the same views as the Traces tab. It hands you the traces to read; it does not read span contents itself, so trace exploration stays your call. It follows the layer's trace configuration and supports **both** trace modes: on a **native** SkyWalking-tracing layer it reads traces by service; on a **Zipkin**-tracing layer (mesh / Kubernetes — Envoy ALS, rover) it first lists the Zipkin services and matches yours to a Zipkin-side name, because Zipkin keys traces on its *own* service names. Either way it captures a capped slice of the most recent traces in its window, with their spans, so the list and every waterfall stay readable later. A layer with no traces component says so. Requires your `traces:read` permission.
- Show a service's **logs** inline — the stored log stream with row → detail, the same view as the layer Logs tab; distinct from the Kubernetes live tail below (these are **stored** logs), gated by your `logs:read` permission. For a **browser** app it can likewise show the **Browser errors** list — the client-side JS error stream with a row → stack-trace detail, gated by your `browser-errors:read` permission. Both capture their rows, so the list and each row's detail open from what was read.
- Read a Kubernetes pod's **on-demand logs** — pull a container's recent logs (the error stack) and show the fetched lines inline as a read-only result. This is the same on-demand-log path as the Pod Logs tab: logs are streamed live from the cluster and never stored, and it requires your `logs:read` permission. The block is a captured result, not a console — it doesn't refresh on its own; ask again to fetch a newer window, or open the **Pod Logs** tab to keep a live tail running. When a content filter was applied, the block shows it, so an empty result reads as "nothing matched this filter" rather than a silent pod. On-demand logs must be **enabled on OAP** (off by default) — if they're disabled, the assistant tells you so rather than failing.
- Show a finished **profiling** result inline — for a code profile the **flame graph** the Profiling tab draws, with the hottest frames called out in the prose; for a **trace** profile, the profiled trace's span **waterfall** beside the flame; for **network** profiling, the **process-conversation graph** (the processes and the conversations between them). Frames are ranked in the unit that profiler reports, and the prose names it: trace profiles rank by **self time in milliseconds**, pprof by **self sample count** (a count, not a duration), on-CPU eBPF by share of **dump count**, off-CPU eBPF by share of **time spent blocked**, and async-profiler depends on what was captured — CPU-family events by **self sample count**, but **ALLOC** by **bytes allocated** and **LOCK** by **contention time in nanoseconds**, since those two events record a value rather than a sample count. A task that captured more than one event renders one at a time; the reply names the others and how to see them. When there is nothing to show — no eBPF agent reporting any process, or a task that ran but sampled nothing — it says so in plain text instead of drawing an empty graph. Reading a result needs your `profile:read` permission.
- Run a **guided root-cause investigation** — it loads a matching playbook (a master **root-cause** method plus focused variants for latency, error-rate/SLA, saturation, middleware, Kubernetes-workload and service-mesh) and works root service → calling chain → error stack, walking the topology upstream and following the layer hierarchy down into backing infra/database layers. A middleware dependency (database / cache / MQ) is a topology leaf with nothing downstream, so the investigation bottoms out there and pivots to its **logs, its Kubernetes hierarchy** (the pods' memory / disk / connection pressure) **and the network edge**.
- Narrate an ordered answer: a sentence or two, then a numbered figure, then interpretation, then the next figure — referencing the figures in the prose. A single running **Figure N** counter numbers *every* inline block — figure, topology, whole-layer map, hierarchy, deployment, instance map, API dependency, traces, Zipkin traces, logs, browser errors, pod logs, profiling flame, network process graph or profiling proposal — so the prose can point at any of them.
- Every data block is a **captured snapshot**, not a live view. The assistant reads the data once, freezes it into the block, and the block stamps **captured &lt;time&gt;** beside a small **replay** badge. Figures, every dependency map (topology, whole-layer map, hierarchy, deployment, instance map, API dependency), traces and Zipkin traces, logs, browser errors, pod logs, the profiling flame (with its trace waterfall) and the network process graph all replay from what was read — so reopening a conversation, or scrolling back through it, shows exactly the data behind the answer, detail popouts and edge sparklines included, without querying OAP again. Nothing in the chat quietly refreshes to current data under an old question. The profiling proposal is the one block that is not data: it is a decision card you act on.

It is **read-only by default**: it observes and explains, and never changes configuration, rules, or dashboards. Every data action it takes checks the **same read permission you already hold**, so the assistant can never see more than you can. The one exception is **profiling**: when metrics and traces can't localise a cause, the assistant may *propose* a profiling task as a decision card (what it found, why profiling, what it expects) — nothing runs until **you approve it** in the popout, and only if you hold the `profile:enable` permission.

**What the assistant will and won't decide for you.** Whether a profiling task is *allowed* is your OAP backend's call, not Horizon's. The assistant checks what it can see beforehand — whether the layer is set up for that profiling type, whether the instances report a runtime the profiler matches, whether any process is reporting eBPF support — but none of those are checks OAP itself performs when a task is created. So it treats them as **caveats, not vetoes**: it shows the card, tells you what looks wrong ("this service reports Java, and pprof is Go-only, so it will probably collect nothing"; "no Rover agent seems to be reporting"), and leaves the decision to you. If OAP does reject the task on approve, the card shows **OAP's own reason** rather than a guess. Two flavour-specific things worth knowing: a **network** profiling task always runs for a fixed **10 minutes** and ignores any window the assistant proposed, and an empty process graph shortly after approval means the task hasn't collected yet — not that profiling is unsupported.

- **Tell you when it can't see, instead of reporting an empty system.** If Horizon cannot read a layer's configuration — OAP's admin endpoint is unreachable, an administrator disabled that layer's template, or the layer was never synced — the assistant names which of those it hit and how much is affected, rather than answering "no metrics available". An unreachable admin endpoint affects **every** layer, so it reports that as the finding and stops instead of trying layer after layer. You can also ask it directly whether Horizon can reach OAP right now, and it reports admin reachability, any unreachable OAP modules, and the template source mode.

## How it stays grounded

The assistant does not free-associate over raw numbers. It answers by combining three sources, and it is the interplay between them — not any one alone — that lets it relate metrics, traces, logs and topology into one coherent picture instead of a pile of disconnected data:

- **Live GraphQL data** — it reads through the **same OAP query-protocol the dashboards use**, so it sees exactly what your dashboards see (metrics, traces, logs, topology, alarms), scoped to your permissions and to its own time window. This is *what is happening right now*.
- **Your layer configuration, used as a skill** — the bundled and stored **layer** and **overview** templates are the assistant's catalog of *what each layer measures and how*: the curated metrics and their **MQE** expressions, each metric's entity **scope** (Service / ServiceInstance / Endpoint), its widget type and unit, and which components a layer carries (traces / logs / deployment / topology / …). This is more than a lookup table — it is effectively a **skill the assistant investigates with**, and its whole troubleshooting path is **driven by** it: the assistant can only reach for a metric, scope, or component the layer actually defines, it renders those metrics **verbatim** rather than inventing them (so a chat figure matches the dashboard), and a layer with no trace component simply says so instead of guessing.
- **SkyWalking's concepts** — the domain model is the connective tissue: layers, entity scopes, the metric catalog and MQE, the service **topology** and the cross-layer **hierarchy**. These are what let the assistant tie a metric to the entity it belongs to, walk a dependency edge, or follow a service down into its backing infrastructure layer.

Because the layer configuration is the **same metadata your dashboards are built from**, what the assistant tells you is always consistent with what you can open and verify yourself — the live data supplies the values, the configuration supplies the meaning, and the SkyWalking model supplies the relationships between sources.

Crucially, that skill is **not immutable** — it is *your* configuration, edited in the **Layer dashboards** admin, so it is a lever you control. Add a metric to a layer, enable a component (traces / logs / deployment), or tune its topology / hierarchy config, and the assistant picks it up and uses it in its next investigation; rescope or remove one and it stops reaching for it. The assistant's investigative reach on a layer **tracks whatever you have configured that layer to measure** — so configuring the layers well is, in effect, how you teach and extend it. (This is separate from the built-in **skill guides and root-cause playbooks** — the fixed investigation *method*; the layer configuration is the per-layer *knowledge* that method operates on.)

## Enabling it

The launcher — a floating **AI Assistant** button on the right edge, after login — shows for every signed-in user, so the assistant is discoverable across the product. Until you turn the feature on and point it at a model, the panel opens **read-only**: it explains what the assistant does and shows a short "ask your administrator to set it up" notice instead of a chat box. Who may actually use it once configured is controlled by RBAC — the `ai:read` permission, granted to every role by default; a user without it still sees the launcher but their request is rejected when sent.

管理员可在 **Admin → AI assistant** 配置开关、提供方、模型、地址、区域和 API 密钥。部署时设置 `HORIZON_AI_SETTINGS_FILE` 为服务进程可写的持久化文件路径；未设置时页面只读。保存后当前进程立即生效；此文件存储方式仅支持单个 Horizon 实例，不支持多实例共享配置。设置文件中的字段优先于 `horizon.yaml` 和环境变量；密钥不回显，目标地址、提供方或区域未变时留空保留原值，目标变更而未填写新密钥时会清除旧密钥。基础地址不能包含用户信息、查询参数或片段，也不要将密钥放入路径。设置文件包含密钥，须限制访问并使用持久化卷；仅拥有 `ai-settings:read` 的角色可以查看状态，修改需要 `ai-settings:write`。已存在的设置文件必须是权限为 `0600` 的普通文件，不可使用符号链接。恢复备份时，先在仅服务账户可写的持久化目录内恢复文件，再将文件所有者设为 Horizon 服务账户、权限设为 `0600`，最后启动服务。已存在的文件无法读取、权限过宽、损坏或字段不完整时服务拒绝启动，以免恢复旧密钥；应从受保护的备份恢复。文件不存在时管理页从禁用、无密钥的状态开始，需重新填写密钥；持久卷丢失时也不会恢复旧密钥。

写模式只能把模型请求发往部署方批准的地址或区域。部署时用 `HORIZON_AI_ALLOWED_BASE_URLS` 列出允许的完整端点（逗号分隔，例如 `https://models.example.com/v1`），用 `HORIZON_AI_ALLOWED_BEDROCK_REGIONS` 列出允许的 AWS 区域（例如 `us-east-1,us-west-2`）。页面保存和管理页配置都不在名单内时保存会被拒绝；名单为空时管理页无法写入。基础地址与区域输入框下方会列出已批准的值，保存被拒时的提示也会带上这份名单，名单为空时说明该改哪个环境变量。填写的是 API 端点，不是供应商的控制台页面。名单只在进程启动时读取，修改后需重启。Bedrock 在托管模式下只使用获批区域的标准 AWS 端点，不跟随 SDK 的端点覆盖配置；OpenAI 兼容请求不跟随重定向。

也可在 `horizon.yaml` 的 `ai:` 块或 `HORIZON_AI_*` 环境变量中配置基础值：

| Field | Env var | Meaning |
|---|---|---|
| `enabled` | `HORIZON_AI_ENABLED` | Master switch. Default `false`. |
| `provider` | `HORIZON_AI_PROVIDER` | Transport: `openai-compatible` (default), `bedrock`, or `anthropic` (Claude API). |
| `model` | `HORIZON_AI_MODEL` | Model id to use. |
| `baseUrl` | `HORIZON_AI_BASE_URL` | Endpoint URL for `openai-compatible`; an optional gateway URL for `anthropic`. |
| `region` | `HORIZON_AI_REGION` | AWS region for `bedrock`. Optional — falls back to `AWS_REGION` / `AWS_DEFAULT_REGION`. |
| `apiKey` | `HORIZON_AI_API_KEY` | **密钥。** 基础配置通过环境变量提供；管理页保存的密钥存入设置文件，不得提交到仓库。 |
| `systemPrompt` | `HORIZON_AI_SYSTEM_PROMPT` | Override the bundled system prompt. Blank → bundled default. |
| `starters` | `HORIZON_AI_STARTERS` | Override the starter example chips (JSON array of strings). Blank → bundled defaults. |

The chat replies over **Server-Sent Events**. If you front Horizon with a reverse proxy, disable response buffering for `/api/ai/chat` (the route already sends `X-Accel-Buffering: no` and a periodic heartbeat) so tokens arrive live rather than in one burst at the end.

## Choosing a provider

The assistant is **vendor-neutral** — it speaks to your model through a pluggable transport, so no specific vendor is required.

**OpenAI-compatible (default)** — any endpoint that speaks the OpenAI chat API: a hosted model, a self-hosted / local model, an AI gateway, or a proxy. Set `model`, `baseUrl`, and `apiKey`:

```yaml
ai:
  enabled: true
  provider: openai-compatible
  model: "your-model-id"
  baseUrl: "https://your-endpoint/v1"
  apiKey: "${HORIZON_AI_API_KEY}"
```

**Amazon Bedrock** — set `provider: bedrock`, use a Bedrock model / inference-profile id as `model`, and a Bedrock bearer API key as `apiKey`. `region` comes from config or the standard AWS environment:

```yaml
ai:
  enabled: true
  provider: bedrock
  model: "your-bedrock-model-id"
  region: "us-west-2"
  apiKey: "${HORIZON_AI_API_KEY}"
```

`model` must be a full Bedrock model or inference-profile id (for example `us.anthropic.claude-3-7-sonnet-20250219-v1:0`) — a bare vendor model id is not auto-prefixed. `apiKey` is a Bedrock bearer key (`ABSK…`). Leave `region` blank and Horizon reads it from the `AWS_REGION` / `AWS_DEFAULT_REGION` environment variables, or set it to pin one. (A region set only in `~/.aws/config` is not picked up — supply it via config or one of those env vars.)

**Anthropic Claude API** — set `provider: anthropic` to call the Claude Messages API directly, with a Claude model id as `model` and a Claude API key as `apiKey`. Leave `baseUrl` blank for the official endpoint; set it only to route through a gateway:

```yaml
ai:
  enabled: true
  provider: anthropic
  model: "your-claude-model-id"
  apiKey: "${HORIZON_AI_API_KEY}"
```

When the assistant is configured from the admin page, a `baseUrl` set for `anthropic` must appear in `HORIZON_AI_ALLOWED_BASE_URLS`; a blank one always uses the official Anthropic endpoint and never follows the SDK's endpoint environment override.

Inference parameters (temperature, output-token caps) are **not** Horizon settings — they are owned by your model/gateway. The assistant fixes temperature at 0 for reliable tool use.

When something upstream fails, production builds show only a generic *internal error* with a request id in the chat — match that id in the server logs for the real cause (the raw upstream message, which can carry your endpoint or a response snippet, is kept out of the browser). Development builds (`NODE_ENV=development`) surface the raw provider error instead.

## Customizing the prompts

Both prompts ship with sensible bundled defaults and can be replaced entirely on the server, for everyone:

- **System prompt** (`ai.systemPrompt`) — the assistant's operating instructions. For a multi-line override in `horizon.yaml`, use a YAML block scalar.
- **Starter prompts** (`ai.starters`) — the example chips shown in an empty chat. Provide your own list to tailor the suggestions to your environment. A starter may embed a `<service>` or `<layer>` placeholder: on click it opens a free-text fill-in (with a live preview) where the user types an approximate name that the model resolves at query time — a quick way to ship parameterized suggestions without hard-coding entity names.

**What an override replaces.** `ai.systemPrompt` replaces the assistant's *method* — how it investigates, what it may query, when to stop. It does **not** replace the presentation rules that tell it how to present an answer in this chat panel; those are always appended. That split exists so a customized prompt cannot, by omission, drop the rule that stops the assistant describing a chart it never drew.

## Permissions

Reaching the assistant requires the `ai:read` permission, granted to the viewer / maintainer / operator / admin roles by default and enforced on every chat request by the server. `ai:read` alone only opens the chat — it grants no data access. Each data tool independently re-checks its **own** read verb before it runs: `metrics:read` (layers, services, the metric catalog and every figure), `alarms:read` (alarms), `topology:read` (the topology graph, the cross-layer hierarchy, and the deployment / instance-map / API-dependency views), `traces:read` (the inline Traces view), `logs:read` (the inline Logs view and pod logs), `browser-errors:read` (the inline Browser errors view), `profile:enable` (the profiling proposal) and `profile:read` (reading a finished profiling result). So the assistant never sees more than you can: a tool you lack the verb for is refused and shows as a **denied** chip in the transcript instead of a result. When you scope a custom role for the assistant, grant `ai:read` for entry plus whichever read verbs you want it to be able to use.

## Conversations

Open the assistant as a **side drawer** from the launcher (drag its left edge to resize it — the width is remembered), **expand it to a full page** (`/ai`) for more room, or open it in a new browser tab. Answers render as formatted markdown.

The assistant keeps its **own time window** — a clock dropdown in the chat header (Last 15m / 1h / 6h / 24h / 3d / 7d, default 1h), separate from the dashboard topbar picker — and scopes every question to it. There is no layer or service picker: name the service or layer in your question (or fill in a starter), and the assistant resolves it.

Each send starts or continues a conversation titled from its first question. The full-page `/ai` view carries a **History** sidebar of past conversations (title + time; click to switch, hover the × to delete) and a **New chat** button, plus a **Save history** toggle, a usage meter and **Clear all**.

History is kept per signed-in user in your browser's IndexedDB — far larger than the previous storage, so long conversations with embedded charts survive — up to a configurable budget (default 500 MB, `HORIZON_AI_HISTORY_MAX_MB`), pruned oldest-first when it fills. **It is stored unencrypted**, so turn **Save history** off on a shared workstation.

Your history is read once, when the assistant opens, and each conversation is saved on its own — saving one never disturbs another. If you have the assistant open in **two tabs** and continue the *same* conversation in both, the second one to save is not silently overwritten: that conversation is marked **Not saved** in the History sidebar, and opening it asks which version you want to keep — the one in front of you, or the one the other tab saved. A conversation whose answer is still streaming shows **In progress** until it is written. Because each tab reads history only at open, the two lists do not update each other while both are open; reload a tab to see what the other one saved.

While an answer is streaming, **Send** becomes **Stop** — Stop, or **Esc** with the drawer open, aborts it and marks the turn *Interrupted* (Esc does not close the drawer; the × does, and closing also stops the stream).
