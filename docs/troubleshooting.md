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

源码修改不会自动生效于已安装的部署目录。待任务结束后 `uninstall`、`install`，再更新豆包连接器参数。不要为了排障删除任务数据库或未知状态记录。

## 豆包里看不到工具

确认已登录豆包工作，使用“本地电脑”运行时，并启用了 `Doubao Codex Gateway` 连接器。连接器选择 STDIO，命令/参数/环境变量逐项来自当前 `connector-config` 输出。

若重装后旧脚本路径失效，重新生成配置。Skill 则需要在上传检查完成后可用，并在对话中选择或明确要求使用。可以先请求 `codex_health`，再请求 `codex_workspaces`；仅在界面看到连接器名称不等于工具能调用。

不要把内部 `/rpc` 当作 HTTP MCP 端点，也不要为此启用 CDP 或修改豆包私有配置。版本和账号不支持原生自定义连接器时，先确认产品能力。

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

## 完成、取消与验收不符合预期

`completed + pending` 是正常的待验收状态。豆包应检查真实产物与用户验收标准，再用 `accept` 提交证据。无效报告、缺失产物或错误 JSON 会被记录为失败。

`cancel_requested` 只是请求中断；确认 `cancelled` 或其他真实终态后再开展冲突工作。取消不回滚修改。

对话结束后没有主动通知也是当前行为：后台任务可继续，但 Gateway 不会自动唤醒豆包对话。回来查询原任务即可。桌面 Codex 侧栏是否显示 app-server 会话也不作保证。
