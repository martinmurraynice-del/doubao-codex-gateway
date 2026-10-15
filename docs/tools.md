# MCP 工具与 CLI 方法

当前工作树提供 14 个 MCP 工具。豆包通过 STDIO MCP 调用；本地诊断可使用 `node src/cli.mjs call METHOD 'JSON'`。CLI 方法名等于工具名去掉 `codex_` 前缀。以下 `?` 表示可选字段。已有安装或连接器缺少新增工具时，需要更新运行版本并刷新工具列表；源码变更不代表部署或公开 Release 已更新。

| MCP 工具 | 参数 | 作用 |
| --- | --- | --- |
| `codex_health` | 无 | 读取服务和 Codex 连接状态，不负责安装或启动服务 |
| `codex_models` | 无 | 查询模型目录；不证明账号权限或额度 |
| `codex_bind_workspace` | `workspace`, `threadId?`, `model?` | 将允许的项目目录绑定到持久 Thread；传入 Thread 必须属于该目录；不派发任务 |
| `codex_workspaces` | 无 | 列出绑定、工作区和 Thread |
| `codex_submit` | `workspace`, `task`, `idempotencyKey`, `constraints?`, `output?`, `model?`, `effort?`, `timeoutSeconds?` | 持久化并排队一个任务，立即返回任务记录 |
| `codex_get` | `id` | 读取完整持久任务、结果和事件游标 |
| `codex_list` | `limit?` | 列出最近任务摘要，默认 20、最多 100 |
| `codex_wait` | `id`, `after?`, `timeoutSeconds?` | 等待状态或事件变化，默认 45 秒，范围 1–50 秒 |
| `codex_events` | `id`, `after?`, `limit?` | 按游标读取有序持久事件，默认 100、最多 500 |
| `codex_collect_images` | `id` | 只读精确 Thread/Turn，收集已缓存且完成的本地原图并返回任务；不启动/恢复模型，不改变执行/验收/容量状态 |
| `codex_cancel` | `id` | 请求取消未派发任务，或请求中断该任务的原始 Turn |
| `codex_rework` | `id`, `feedback`, `idempotencyKey` | 已确认结束且不占用容量的任务继续返工，保留任务 ID、Thread、目录和历史 |
| `codex_accept` | `id`, `evidence`, `artifactPaths?` | 对 `completed` 任务记录独立验收证据，并检查指定产物路径 |
| `codex_recover` | `id`, `note` | 核对中断/未知状态的精确 Turn，不重新执行任务 |

## 连接状态与升级

完成当前安装后，`node src/cli.mjs connector-config` 优先提供固定 `bin/mcp.mjs` 入口。启动器每次启动按 `installation.json` 加载当前部署；从旧时间戳脚本路径迁移一次后，部署升级通常不必修改豆包参数，但要重新连接 MCP/刷新工具列表。Node 路径或状态目录变化时需重新核对配置；Skill 更新仍需重新导入。

`codex_health` 的 `ok` 说明网关能响应，`codexConnected` 说明当前 Codex 传输是否连接；`connectionScope: "transport_only"` 明确这不是任务执行验收。两者都不证明账号可推理或原任务已完成。`lastProtocolError` 保留本次服务进程内最近的协议错误（安全错误码、固定说明和时间），重新连接不会清空它；为 `null` 也不代表已通过派工测试。传输断开后会按指数退避尝试单一重连，不重放工具提交或原任务，也不自动释放 `uncertain` 容量。连接恢复后查询原 ID，必要时显式调用 `codex_recover`。

认证健康响应同时包含 `connection: {status, attempts, nextRetryAt}`：`status` 为 `connected/reconnecting/stopped`，`attempts` 表示本轮已开始的重连次数，`nextRetryAt` 为已排定重试的时间或 `null`。默认退避从 1 秒开始，逐步增加至最多 30 秒；正在尝试时 `nextRetryAt` 可为空。公开 `GET /health` 仍只返回最小服务状态。

MCP 客户端每次 RPC 都读取当前 `connection.json` 和令牌，后台服务重启后无需把新令牌复制到豆包。接口仍可能在重启期间返回错误；不得将“可重连”理解成可以换幂等键重投。后台服务需要电脑开机、用户登录及有效账号/网络，且不会主动唤醒已经结束的豆包对话。

## 提交参数

- `workspace`：已存在的绝对目录，真实路径必须位于配置的 `allowedRoots` 内。
- `task`：非空目标和验收标准，最多 60,000 字符。
- `idempotencyKey`：最多 200 字符。对同一个意图保持稳定；相同键用于不同内容会被拒绝。
- `constraints`：最多 40 条，每条最多 4,000 字符。
- `output`：`text`（默认）、`json` 或 `artifacts`。
- `model`：当前任务显式模型。优先级高于绑定模型和 Gateway 默认模型。
- `effort`：`low`、`medium`、`high` 或 `xhigh`；模型是否支持仍以 Codex 返回为准。
- `timeoutSeconds`：任务期限，默认 7,200 秒（120 分钟），范围 10–86,400 秒。它与单次 `wait` 等待时间不同。

图片任务应按生成、格式处理和验证的工作量选择期限，不要机械套用显式 300 秒；用户要求的时间或费用预算优先。到期后不能自动重试或修改期限绕过限制。

示例中的路径必须替换为自己的允许目录：

```sh
node src/cli.mjs call submit '{"workspace":"/absolute/path/to/project","task":"创建一个说明文件并读取核对内容。","idempotencyKey":"example-write-001","output":"artifacts"}'
```

提交返回不等于完成。响应丢失时先用 `list/get` 查找持久任务，不用新键重复提交。

## 等待、事件和结果

MCP 成功响应的 `structuredContent` 为 `{ "result": ... }`；失败响应包含 `{ "error": { "code", "message", "outcomeUnknown" } }` 并设置 `isError`。CLI 直接打印方法返回值。

`wait` 返回 `{run, events, timedOut}`。保存 `run.id` 和 `run.cursor`，后续将游标作为 `after` 传入。`timedOut: true` 只结束本次等待，不取消、不重放任务。

```sh
node src/cli.mjs call get '{"id":"TASK_ID"}'
node src/cli.mjs call wait '{"id":"TASK_ID","after":0,"timeoutSeconds":45}'
node src/cli.mjs call events '{"id":"TASK_ID","after":0,"limit":100}'
```

任务的 `result.text` 是执行报告，`result.data` 是结构化结果，`result.artifacts` 是 `{path, name, bytes}` 文件清单。文件经过存在性和工作区真实路径检查，`path` 为绝对路径，不是自动上传链接。

## 原图记录与收集

任务的 `images[]` 独立于最终 `result`，可在 `get/wait` 的任务记录和图片相关持久事件中追踪。记录包含：

| 字段 | 含义 |
| --- | --- |
| `itemId`, `threadId`, `turnId`, `attempt` | 图片项与精确执行轮次的关联 |
| `status`, `savedPath`, `failure?` | 生成状态、原始缓存路径以及可能的失败信息 |
| `artifact` | 保底副本 `{path, name, bytes, sha256, mimeType}`，未完成复制时可为 `null` |
| `delivery` | `{status: "copied" / "pending" / "failed", error?}`，表示复制状态，不是任务完成状态 |

已完成本地原图的保底路径为 `.doubao-codex/artifacts/<task>/attempt-<n>/<item>.<真实扩展名>`，位于任务工作区。保留原文件和真实格式，不自动转 JPG，不把 partial 图片当作完成图。图片事件、`finish` 和 `reconcile` 时会尝试保底复制。

每个任务跨返工轮次最多保留 100 个图片项记录，包含未完成或复制失败的记录；不是每轮重新计算。达到上限后，新图片项不再自动复制，任务返回 `imageCollectionWarning.code: IMAGE_RECORD_LIMIT` 并产生 `image_warning` 事件。已有记录仍可查询和更新。出现警告时不能声称所有原图已回收，应报告遗漏并核查原 Codex 会话。

PNG/JPEG/WebP 的 MIME 类型与扩展名根据文件字节的头部和容器结构判断，不执行完整像素解码或转码。`delivery.status=copied` 不等于图片可完整解码、内容正确或最终格式验收通过。路径检查也不构成对敌对本地进程并发文件替换的绝对隔离。

```sh
node src/cli.mjs call collect_images '{"id":"TASK_ID"}'
```

`collect_images` 支持旧任务，仅核对任务持久化的精确 Thread/Turn 并收集已缓存原图。读取模型记录不会启动或恢复模型，也不会重新生成；完成图片的保底副本会写入工作区。因此它不是纯文件系统只读操作，但不会扩大文件访问权限。返回任务的 `status`、`review`、`holdsCapacity` 保持不变。

即使任务失败、取消或 `result=null`，也可能仍有可回收图片。先查 `images` 并收集，再判断剩余交付工作；不能仅凭空结果重新生成。复制完成也不代表格式、尺寸、数量和内容已达标，最终应对用户要求的文件做独立验收。

## 返工、接受和恢复

返工需要新的稳定幂等键，复用原任务 ID。`feedback` 最多 60,000 字符。它可用于已终止的 `completed/failed/blocked/cancelled` 任务，但任何容量占用或未知执行状态必须先处理。

```sh
node src/cli.mjs call rework '{"id":"TASK_ID","feedback":"修正具体未达到的验收项。","idempotencyKey":"example-rework-001"}'
node src/cli.mjs call accept '{"id":"TASK_ID","evidence":"已独立读取输出文件并确认具体测试结果。","artifactPaths":["result.md"]}'
node src/cli.mjs call recover '{"id":"TASK_ID","note":"已检查原会话和文件，核对保存的执行轮次。"}'
```

以上是接口示例，只有实际做过检查才能填写相应验收证据。`evidence` 最多 12,000 字符；`note` 最多 4,000 字符。`accept` 不替监督者执行测试。

`rework` 继承原任务显式模型，没有模型覆盖参数。`cancel_requested` 不等于 `cancelled`；取消也不会回滚已经发生的文件修改。`recover` 不能把未保存 Turn ID 的未知执行猜测为成功，不提供强制放行或自动重投。

状态和恢复细节见 [架构](architecture.md)，常见错误见 [排障](troubleshooting.md)。
