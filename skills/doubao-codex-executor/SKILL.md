---
name: doubao-codex-executor
description: 通过 Doubao Codex Gateway 连接器指挥本机 Codex 执行持久编程和文件任务。用于派工、继续原任务、查进度、指定执行模型、验收和返工；豆包负责监督，Codex 负责本地执行。
---

# 豆包指挥 Codex

## 连接与工作区

使用实际可调用的 `codex_*` 连接器工具。只有 Skill 没有工具时，明确说明还需按项目 README 注册本地 STDIO 连接器，并启用本 Skill；不能假装已经派工。连接失败或未登录时报告原始阻塞，不自行改凭据、端口或安装配置。

先调用 `codex_health {}` 与 `codex_workspaces {}`。从用户上下文或已有绑定确定获准使用的绝对项目目录；只有影响正确执行的目录或范围无法确定时才询问。新工作区可调用 `codex_bind_workspace {workspace}`；`codex_submit` 也会自动绑定。已有工作区沿用原线程，继续任务先用 `codex_get {id}`，遗失 ID 时用 `codex_list {limit}` 查找。仅查询进度的请求不授权追加执行或返工。

工具成功返回 `{result: ...}`；错误返回 `{error: {code, message, outcomeUnknown}}`。下文的任务字段均指解包后的结果，避免把工具调用成功误读为任务完成。

## 用户指定模型时

1. 调用 `codex_models {}`，使用返回的 `models[].id`、`displayName` 与 `reasoningEfforts` 解析用户的自然语言模型名。若名称对应多个版本且上下文无法区分，先说明候选并确认；不要猜 ID 或固定某个模型为默认值。
2. **把选定的精确 ID 写入 `codex_submit.model`。** 只在 `task` 文案中写“使用某模型”不会切换执行模型。派工后用返回任务的 `model` 核对已记录的选择。
3. 用户指定推理强度时，`effort` 只能使用 `low`、`medium`、`high`、`xhigh`，并与所选模型支持的值匹配。用户未指定模型或强度时省略相应字段，沿用现有工作区、网关及 Codex 默认配置。
4. 模型目录不证明账号有使用权限或剩余额度。模型不在目录中、强度不受支持或执行时报无权限时，说明具体问题与可用选择，不静默换模型或降级后重新提交。

`codex_bind_workspace.model` 用于用户要求的工作区默认模型变更，不能覆盖任务已显式保存的 `model`。`codex_rework` 仅接受 `id`、`feedback`、`idempotencyKey`，保留原任务显式模型及强度；不要传入不存在的 `model` 参数，也不要承诺运行中切换。用户要给已有任务换模型时先说明这项限制，待原执行已结束后，按获准的新任务安排处理。

## 派工

调用 `codex_submit` 时提供：

- `workspace`：获准使用的绝对项目目录。
- `task`：具体目标与可检查的验收条件；`constraints` 可列出限制。
- `idempotencyKey`：该次动作的唯一稳定键，保存到本轮跟踪信息。
- `output`：总结用 `text`，结构化结果用 `json`，必须有交付文件用 `artifacts`。
- 按需填写 `model`、`effort`、`timeoutSeconds`。执行超时范围为 10–86400 秒，省略时为 1800 秒；它不是等待接口的超时，也不是费用限额。

记录返回的 `id`、`threadId`、`attempt`、`cursor` 与显式模型选择。新目标用新任务键；一次动作发生网络重试仍使用原键和完全相同的参数。提交响应不明时先用 `codex_list` / `codex_get` 查找原任务；无法排除重复执行时停止追加提交，不能换键“再试一次”。

## 有限的自主监督循环

用户授权完成目标后，在原范围内持续执行“等待 → 检查 → 必要时返工”，不要求用户逐次批准常规跟进。遵守用户给定的时间、轮次和费用预算；没有明确预算时，默认本次跟进不超过 30 分钟、最多两轮返工，并向用户说明。用户已明确指定更长监督期限或不同上限时以其要求为准。达到边界时交付当前状态与原任务 ID；结束监督不等于取消正在执行的任务。

1. 非终态使用 `codex_wait {id, after, timeoutSeconds:45}`。解包后读取 `run`、`events`、`timedOut`，将后续 `after` 更新为实际收到的最后一个事件的 `seq`；无事件时使用 `run.cursor`。若它仍小于 `run.cursor`，用 `codex_events {id, after, limit}` 分页补读并保存返回的 `cursor`，避免跳过未读事件。正常长轮询没有新事件时继续等待，不密集轮询多个端点。
2. `queued`、`dispatching`、`running` 或 `cancel_requested` 仍需跟进。等待超时不会取消任务，也不能据此重交任务。连接持续出错时停止重试循环，报告连接问题与已知任务状态。
3. `status=completed` 仅表示执行结束且输出格式有效；`review=pending` 表示尚未验收。按下面的验收流程检查成果。
4. `blocked` / `failed` 先读取真实原因。原范围内、原因明确且前一轮已确认结束的普通缺陷可进入返工。涉及新权限、登录、用户输入、额外预算或范围变化时暂停依赖这些条件的工作并报告；不得自动批准高权限、停用沙箱或修改白名单。
5. `uncertain` 或 `holdsCapacity=true` 且执行归属不明时停止追加工作。查看原任务与事件，必要时调用一次 `codex_recover {id, note}` 核对原始轮次；仍无法确认就交给用户处理。不能循环恢复、另建任务绕开占用或直接修改数据库。

用户要求停止时调用 `codex_cancel {id}`，以返回的 `status=cancelled` 确认停止；`cancel_requested` 只表示提出了请求。已产生的文件修改不会自动回滚。

## 验收、返工与交付

读取任务的 `result.text`、`result.data`、`result.artifacts` 与测试证据。产物项包含 `path`、`name`、`bytes`；文件存在或 Codex 自报完成均不能代替内容验收。有独立文件、终端或浏览器工具时，在授权范围内读取成果、检查差异或运行验证；没有时明确哪些内容未直接核对，保留待验收状态。

满足验收条件后调用 `codex_accept {id, evidence, artifactPaths}`，写入实际做过的独立检查与已核对的文件路径。成功后任务仍是 `status=completed`，另有 `review=accepted`；`accepted` 不是执行状态。此工具仅记录证据并检查路径，不会替调用方运行测试。

需要修改且仍在监督预算内时，调用 `codex_rework {id, feedback, idempotencyKey}`：保留原任务 ID，逐项写明未满足的验收条件，每一轮返工使用新的稳定键。它保留线程、工作区和历史并递增 `attempt`；随后回到等待循环，不另建项目或清空已有成果。

在豆包聊天交付结果总结、核验情况、剩余问题、产物绝对路径和任务 ID。只有实际启动并验证的网页才给出预览地址；本地路径不自动等于可下载附件或云端链接。

后台网关独立保存队列并执行已提交的任务，但 **本 Skill 不能在豆包对话结束后自动唤醒豆包、继续验收或主动通知**。下次对话按原 ID 恢复跟进；持久执行与持续监督是两件事。网关使用本机 `codex app-server`、现有登录态与持久线程，最终汇报在豆包，文件在本机项目目录；不承诺会话自动显示在 Codex 桌面侧栏。
