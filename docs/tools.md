# MCP 工具与 CLI 方法

网关提供 13 个 MCP 工具。豆包通过 STDIO MCP 调用；本地诊断可使用 `node src/cli.mjs call METHOD 'JSON'`。CLI 方法名等于工具名去掉 `codex_` 前缀。以下 `?` 表示可选字段。

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
| `codex_cancel` | `id` | 请求取消未派发任务，或请求中断该任务的原始 Turn |
| `codex_rework` | `id`, `feedback`, `idempotencyKey` | 已确认结束且不占用容量的任务继续返工，保留任务 ID、Thread、目录和历史 |
| `codex_accept` | `id`, `evidence`, `artifactPaths?` | 对 `completed` 任务记录独立验收证据，并检查指定产物路径 |
| `codex_recover` | `id`, `note` | 核对中断/未知状态的精确 Turn，不重新执行任务 |

## 提交参数

- `workspace`：已存在的绝对目录，真实路径必须位于配置的 `allowedRoots` 内。
- `task`：非空目标和验收标准，最多 60,000 字符。
- `idempotencyKey`：最多 200 字符。对同一个意图保持稳定；相同键用于不同内容会被拒绝。
- `constraints`：最多 40 条，每条最多 4,000 字符。
- `output`：`text`（默认）、`json` 或 `artifacts`。
- `model`：当前任务显式模型。优先级高于绑定模型和 Gateway 默认模型。
- `effort`：`low`、`medium`、`high` 或 `xhigh`；模型是否支持仍以 Codex 返回为准。
- `timeoutSeconds`：任务期限，默认 1,800 秒，范围 10–86,400 秒。它与单次 `wait` 等待时间不同。

示例中的路径必须替换为自己的允许目录：

```sh
node src/cli.mjs call submit '{"workspace":"/absolute/path/to/project","task":"创建一个说明文件并读取核对内容。","idempotencyKey":"example-write-001","output":"artifacts","timeoutSeconds":300}'
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
