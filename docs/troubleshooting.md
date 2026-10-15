# 排障

先在源码目录运行 `node src/cli.mjs doctor`。它检查 Node、配置、Codex 版本/登录、网关健康状态和 macOS 服务注册；服务尚未启动时会报告不可连接，这不等于需要重新安装账号。

## 服务无法启动或连接

| 现象 | 检查与处理 |
| --- | --- |
| `NOT_CONFIGURED` | 使用 `init --allow-root ... --codex-bin ...` 创建配置。目录和可执行文件必须是真实路径 |
| `CONFIG_EXISTS` | 已有配置受到保护；编辑当前配置文件，不重复初始化或覆盖运行数据 |
| Node/SQLite 不兼容 | 使用 Node.js 24+，再运行 `npm ci` 和 `npm test` |
| Codex 不存在或未登录 | 检查配置里的 `codexBin`、`codex --version`、`codex login status`，使用 Codex 自己的登录流程 |
| 端口占用或已有 daemon | 检查前台服务与 LaunchAgent，确认没有同时使用相同端口/状态目录的实例 |
| LaunchAgent 已注册但不健康 | 查看状态目录中的 `service.error.log` 和 `service.log`，检查实际部署脚本及 Node 路径 |
| MCP 客户端找不到服务 | 比较服务和 `connector-config` 输出中的 `GATEWAY_STATE_DIR`；重新生成连接器参数 |

默认配置根目录为 `~/Library/Application Support/DoubaoCodexGateway`，实际路径也可能被 `GATEWAY_CONFIG` 或 `GATEWAY_STATE_DIR` 覆盖。不要把源码目录当成默认运行数据目录。

源码修改不会自动生效于已安装的部署目录。待任务结束后 `uninstall`、`install`，再重新连接 MCP 并刷新工具。旧时间戳脚本入口需按 `connector-config` 迁移一次到固定 `bin/mcp.mjs`；已使用固定入口且 Node/状态目录未改变时，无需每次改豆包参数。不要为了排障删除任务数据库或未知状态记录。

## 豆包里看不到工具

确认已登录豆包工作，使用“本地电脑”运行时，并启用了 `Doubao Codex Gateway` 连接器。连接器选择 STDIO，命令/参数/环境变量逐项来自当前 `connector-config` 输出。

若重装后旧脚本路径失效，重新生成配置并改用固定入口；若入口已固定但仍只看到旧工具，重新连接 MCP，让新进程重新读取 `installation.json`，再刷新工具列表。固定入口不热更新已经运行的 MCP 进程。Skill 则需要在上传检查完成后可用，并在对话中选择或明确要求使用。可以先请求 `codex_health`，再请求 `codex_workspaces`；仅在界面看到连接器名称不等于工具能调用。

新增 `codex_collect_images` 但连接器中未出现时，说明运行部署或工具列表仍是旧版。需要更新相应网关版本并刷新连接器；不能把本地源码已修改说成工具已可用。本次图像保底修复的文档不代表已部署或公开 Release 已更新。

不要把内部 `/rpc` 当作 HTTP MCP 端点，也不要为此启用 CDP 或修改豆包私有配置。版本和账号不支持原生自定义连接器时，先确认产品能力。

## 如何理解“长期连接”

连接的是本机 Gateway 与持久 Codex Thread，不是某个 Codex 聊天窗口。安装的 LaunchAgent 用 `RunAtLoad/KeepAlive` 在用户登录会话中维持服务；关闭聊天不等于停服，关机、休眠、退出用户登录、账号失效或网络不可用仍会影响工作。不能保证永不中断，也不会自动继续已经结束的豆包对话。

`codex_health` 能返回但 `codexConnected=false` 时，网关与 Codex 的传输连接暂不可用。后台按指数退避且只运行一个重连流程；先检查 Codex 可执行文件、登录状态与服务日志，不要密集调用提交、循环恢复或反复重装。传输恢复不表示原任务安全完成，原先的 `uncertain` 和容量占用仍需通过原任务 ID 核对。

服务重启后，客户端下一次 RPC 会读取新的 `connection.json` 和私有令牌，不需要手工把令牌写入豆包。重启期间的一次请求仍可能失败；先查原任务，不自动重新提交。若持续 `GATEWAY_UNAVAILABLE`，检查 LaunchAgent、相同 `GATEWAY_STATE_DIR` 与当前部署；若仍是旧工具，则刷新 MCP 连接。

## 历史图片较多时读取、恢复或派工断连

若健康检查显示已连接，但读取或恢复含多张图片的会话后又断连，不要只按网络故障处理。旧版本的原始消息上限为 32 MiB，历史图片的内联 `imageGeneration.result` 可能使整条会话回复超限；该故障可以发生在新任务真正派发之前。

本次修复对该字段进行精准流式省略，保留完整 Thread/Turn 历史、标识、文字、`savedPath` 与失败信息。它不删除原图或历史，不修改 Skill，也不新增/替换 MCP 工具。只更新源码不会更新运行中的后台代码，应按维护流程安装经过验证的版本；是否部署及端到端通过，以[验证记录](verification.md)为准。

排查时先查询 `codex_health` 与原任务：`connectionScope: "transport_only"` 意味着连接成功不等于历史读取或派工成功；`lastProtocolError` 为最近协议错误或 `null`。错误记录在成功重连后仍保留，服务重启后可能清空，因此要同时看其时间、原任务错误和实际调用结果，不能只看当前连接布尔值。

`CODEX_MESSAGE_TOO_LARGE` 表示触发传输保护限制，`PROTOCOL_ERROR` 表示 JSON 或协议异常。当前默认原始帧上限为 512 MiB，保留 JSON 上限为 32 MiB，另有深度 128 和 500,000 个值的限制；详见[有界传输](architecture.md#大图片历史的有界传输)。这不改变单张原图复制或每任务图片记录的限制。

不要为“恢复连接”删除图片、清空数据库/会话历史、关闭大小限制、仅保留最新轮次或另建会话盲目重投。先查已有任务，核实是否保存派发意图与精确 Turn；`uncertain` 必须继续按原轮次处理。需要补收已有图片时用 `collect_images`，不能用重新生成来掩盖传输问题。

## 模型显示在列表里，但调用失败

`codex_models` 是目录，不是账号授权/额度检查。使用当前认证方式支持的精确模型名，通过小任务验证。Gateway 不会自动 fallback，也不会替你修改全局 Codex 配置。

模型优先级是任务显式模型 → 工作区绑定模型 → Gateway 默认模型。检查 `codex_get` 的 `model` 和 `codex_workspaces` 的绑定模型；只改默认配置可能对已有绑定或任务没有作用。

工作区没有活动任务时，可以用 `codex_bind_workspace` 更新绑定模型。已经显式指定模型的任务仍覆盖绑定；`codex_rework` 会继承该任务模型，目前没有修改任务模型的工具。必须先核实原执行已终止，再明确决定使用新模型的新任务，不能在结果未知时换模型重投。

## 工作区或产物被拒绝

`WORKSPACE_DENIED` 表示目录不在配置的允许根目录内，或解析后的符号链接路径位于外部。配置应指向具体项目目录，重启服务加载修改前先处理活动任务。

产物必须是工作区内已经存在的普通文件，符号链接也会检查最终目标。返回文件路径不自动上传附件；需要在本机打开或另外明确安排发布动作。

## 等待超时或状态不确定

`wait` 超时：使用原任务 ID 和最新游标继续等待。它不会取消任务。

提交返回超时/网络错误：先 `list/get` 查找持久记录。不能更换幂等键盲目重投，因为原执行可能已经开始。

`uncertain`：先查看任务的 `threadId`、`turnId`、事件和真实文件，再调用 `recover` 核对精确 Turn。没有 Turn ID 或无法确认原 Turn 终止时仍会保持未知状态和容量占用，不自动重做。

`THREAD_BUSY`：已有外部 Turn 占用绑定会话。Gateway 不把它当成本任务，也不自动替你中断；在其结束后核对恢复。

`BINDING_UNCERTAIN`：会话创建结果不明确。检查原会话，显式绑定经过核实且属于同一工作区的 Thread；不要连续创建新会话。

## 图片似乎没有交付，或任务在生成后失败/取消

先检查任务的 `images[]` 和图片事件，不要因为 `result=null` 或缺少 `result.artifacts` 就断言没有生成。已完成原图可能仍在缓存中，还没进入最终报告。

```sh
node src/cli.mjs call get '{"id":"TASK_ID"}'
node src/cli.mjs call collect_images '{"id":"TASK_ID"}'
```

`collect_images` 只读取原任务的精确 Thread/Turn 并收集已缓存原图，不启动/恢复模型，不消耗一次新的生成，也不改变执行、验收或容量状态。旧任务和失败/取消任务同样可用；无法读取缓存或保存副本时，应按记录报告失败，不扩大目录权限或直接重新生成。

| 检查 | 含义与后续处理 |
| --- | --- |
| `images[].status` 未完成 | 不把 partial 原图作为完成品验收 |
| `delivery.status=pending` | 副本尚未确认保存；检查记录并尝试收集已有完成原图 |
| `delivery.status=failed` | 查看 `delivery.error`，保留原始状态并处理真实路径/访问问题 |
| `delivery.status=copied` | 在 `artifact.path` 可找到保底副本；仍需检查生成状态、MIME、尺寸和内容 |
| `imageCollectionWarning.code=IMAGE_RECORD_LIMIT` | 任务跨全部返工已有 100 个图片记录，新图片项未复制；如实说明遗漏并检查原会话，不把现有清单当作全部原图 |
| 有原图但任务为 `failed/cancelled` | 可以如实交付已回收成果与未完成条件，不能强行调用 `accept` |
| 原图是 PNG，用户要求 JPG | 保留 PNG，在授权范围内另外转换并验证真正 JPEG；只改后缀不算转换 |

保底路径在工作区 `.doubao-codex/artifacts/<task>/attempt-<n>/`。每完成一张图片就尽早保留原图并完成必要的格式、命名与验证，避免整批生成结束才处理文件。任务期限应覆盖这些步骤；默认 7,200 秒（120 分钟），用户指定预算优先，不能因超时自动重试或延长期限绕过限制。

网关只检查图片文件头和容器结构，不完整解码像素。若副本存在但无法打开，保留原图并用独立图像工具检查；不要把复制成功等同于有效成品。避免其他进程同时移动或改写源图和交付目录，本地文件安全检查不保证防御所有敌对并发替换。

## 完成、取消与验收不符合预期

`completed + pending` 是正常的待验收状态。豆包应检查真实产物与用户验收标准，再用 `accept` 提交证据。无效报告、缺失产物或错误 JSON 会被记录为失败。

`cancel_requested` 只是请求中断；确认 `cancelled` 或其他真实终态后再开展冲突工作。取消不回滚修改。

对话结束后没有主动通知也是当前行为：后台任务可继续，但 Gateway 不会自动唤醒豆包对话。回来查询原任务即可。桌面 Codex 侧栏是否显示 app-server 会话也不作保证。
