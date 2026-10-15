# 豆包工作 → Codex Gateway

让豆包工作定义任务、跟踪进度和验收，让本机 Codex 在固定项目目录与持久会话中执行。结果以完成摘要、验证信息和文件路径返回豆包工作，实际产物保留在你的电脑上。

Gateway 使用本机 `codex app-server`，通过独立后台服务和 SQLite 保存任务。豆包工具调用超时或断开后，已提交的工作不会因为客户端重试而重新执行。

```mermaid
flowchart LR
  A["豆包工作 + executor Skill"] --> B["STDIO MCP 适配器"]
  B --> C["本机 Gateway + SQLite"]
  C --> D["Codex app-server"]
  D --> E["持久 Thread + 项目文件"]
  E --> C
  C --> B
  B --> A
```

当前工作树提供 14 个 MCP 工具：工作区绑定、幂等提交、事件续读、等待、图片原图收集、取消、返工、恢复和独立验收。`completed` 表示执行结束，`accepted` 表示监督者已经检查结果。新增工具需要安装对应网关版本并刷新豆包连接器，已有安装或 Release 不会随源码修改自动更新。

已在 macOS 上验证真实豆包工作 → MCP → Codex → 文件产物 → 豆包验收链路，以及后台服务重启后同会话返工。测试范围见 [验证记录](docs/verification.md)。这不代表克隆仓库后已经完成你本机的配置。

## 快速开始

需要：

- macOS（当前已验证的平台）。
- Node.js 24+。
- 支持 `app-server` 的 Codex CLI，且已完成账号登录或有效认证配置。
- 豆包工作，能够使用本地电脑、自定义 STDIO 连接器和上传技能。

### 1. 安装与检查

```sh
git clone https://github.com/martinmurraynice-del/doubao-codex-gateway.git
cd doubao-codex-gateway
npm ci
npm test
```

确认 `node --version`、`codex --version` 和 `codex login status`。Gateway 复用本机 Codex 的认证，不替你登录或切换账号。

### 2. 配置并启动

将以下路径替换为自己的值；项目目录必须已经存在：

```sh
node src/cli.mjs init \
  --allow-root "/absolute/path/to/project" \
  --codex-bin "/absolute/path/to/codex"
node src/cli.mjs serve
```

如果已知道当前账号支持的精确模型 ID，可在 `init` 命令追加 `--model "MODEL_ID"`；省略时网关配置为 `null`，初次创建会话使用 Codex 自身默认值。服务启动后可用 `node src/cli.mjs call models '{}'` 查询目录，再通过小任务验证可用性。`--allow-root` 可以重复指定多个明确项目目录。

`serve` 在当前终端运行。在另一个终端检查：

```sh
node src/cli.mjs doctor
node src/cli.mjs status
```

需要登录后后台运行时，先结束前台服务，再安装 macOS 用户级 LaunchAgent：

```sh
node src/cli.mjs install
node src/cli.mjs doctor
```

不要同时启动前台服务和后台服务占用同一端口。默认监听回环地址，端口 `18593`。安装的 LaunchAgent 使用 `RunAtLoad` 和 `KeepAlive`，在用户登录会话中启动并维持后台服务；它不是关机后仍运行的云服务。

配置与数据默认位于当前用户的 `~/Library/Application Support/DoubaoCodexGateway`：

| 位置 | 内容 |
| --- | --- |
| `config.local.json` | 允许目录、Codex 可执行文件、模型、端口及并发数 |
| `data/` | SQLite、连接信息、私有令牌和服务日志 |
| `deployments/<timestamp>/` | `install` 复制的运行代码与依赖 |
| `installation.json` | 当前安装的运行目录 |
| `bin/mcp.mjs` | 固定 MCP 启动器，启动时读取当前安装记录 |

配置字段见 [config.example.json](config.example.json)。`GATEWAY_CONFIG` 可覆盖配置文件，`GATEWAY_STATE_DIR` 可覆盖状态目录；服务与 MCP 客户端必须使用同一个状态目录。不要把运行数据或令牌提交到仓库。

### 3. 在豆包工作中注册连接器和 Skill

运行：

```sh
node src/cli.mjs connector-config
```

在豆包工作技能中心选择“新建/添加” → “新建自定义连接器”，按当前命令输出填写：

| 界面字段 | 来源 |
| --- | --- |
| 名称 | `Doubao Codex Gateway` |
| 传输类型 | `STDIO` |
| 命令 | `command` 的完整值 |
| 参数 | `args` 的每一项，逐项填写 |
| 环境变量 | `env` 中的键和值 |

使用“本地电脑”运行时，等待连接成功并检查工具列表。不要将网关内部 `/rpc` 地址填成 HTTP MCP 地址。正常原生注册无需 CDP，项目不依赖 doubao-cli。

完成当前版本的 `install` 后，`connector-config` 优先输出固定的 `bin/mcp.mjs` 入口。它每次启动都按 `installation.json` 选择当前部署，因此后续升级通常无需修改豆包中的脚本参数，但仍要重新连接 MCP/刷新工具列表，旧进程不会热加载新工具。旧安装直接指向 `deployments/<timestamp>/src/mcp.mjs` 时，先按新输出迁移一次；Node 路径或状态目录改变时也应重新核对配置。

按本文从当前源码安装时，在仓库根目录运行：

```sh
npm run skill:pack
```

在技能中心选择“上传技能”，上传生成的 `dist/doubao-codex-executor.zip` 并等待应用检测完成；已有同名技能时选择替换。也可以上传 [Skill 源文件](skills/doubao-codex-executor/SKILL.md) 或包含它的技能文件夹。

[最新 Release 的 Skill ZIP](https://github.com/martinmurraynice-del/doubao-codex-gateway/releases/latest/download/doubao-codex-executor.zip) 仅对应该 Release 的标签版本，不会随源码推送更新；安装未发布源码时不要用旧 Release 的 ZIP 代替当前包。ZIP 不在源码中维护生成副本。

连接器提供工具，`Doubao Codex Executor` Skill 规定任务监督和验收方式，两者都需要启用。不同豆包版本的菜单名称或账号能力可能不同，详见 [接入说明](docs/doubao-integration-research.md)。

### 4. 发起任务

在豆包工作中选择连接器和 Skill，说明项目绝对路径、目标与验收标准。例如：

> 使用 Doubao Codex Executor 和 Gateway，在我指定的项目目录中完成这个修改。提交一次，保留任务 ID 和事件游标。完成后读取实际产物并检查测试证据，需要返工时继续原任务和会话，验收通过再向我汇报。

第一次先让豆包调用 `codex_health` 和 `codex_workspaces`，再在允许的测试目录中创建一个小文件并读取核对。

## 模型选择

模型优先级是：任务 `codex_submit.model` → 工作区绑定模型 → Gateway 配置模型。网关配置为空时，初次会话使用 Codex 默认模型；已有绑定会保留其模型。

`codex_models` 返回模型目录，不证明账号权益、剩余额度或实际可调用性。网关不会在模型调用失败时自动切换模型。通过真实的小任务验证所选模型；需要修改绑定模型时，先处理完该工作区的活动任务。

同任务返工会继承原任务显式指定的 `model`，`codex_rework` 没有单独的模型覆盖参数。若原任务指定了无权限模型，不要误以为只改网关默认值就能改变该任务。详见 [排障](docs/troubleshooting.md)。

## 持久工作流的边界

- 连接的是本机 Gateway 和持久 Codex Thread，不是当前 Codex 聊天窗口；关闭一个聊天不等于卸载后台服务。
- Codex 传输断开后，网关以单一重连流程和指数退避尝试恢复连接；不重放任务，也不自动清除 `uncertain` 的容量占用。
- 提交和返工都使用稳定幂等键。响应丢失先查已有任务，不换新键重投。
- 等待超时不取消任务。使用原任务 ID 和游标继续 `wait/get/events`。
- `uncertain` 表示无法确认原始执行结果，会保留容量；恢复只核对精确的持久化 Turn，不自动重放。
- 返工保留任务、会话、目录和历史；验收需要独立证据，不能只转述 Codex 的完成声明。
- 结果文件保存在本机，不自动上传、托管网页或变成豆包附件。
- 不保证会话出现在 Codex 桌面侧栏，也不会自动唤醒已经结束的豆包对话。可回到豆包查询原任务。
- 需要电脑开机且用户已登录、服务可运行、账号与网络可用；不保证永不中断，休眠和关机期间不执行或恢复监督。

网关检查 `allowedRoots` 与产物路径，并使用 Codex `workspace-write`、`approvalPolicy: never`。额外审批不会被自动放行。允许目录检查不是底层工具的完整读取隔离；此项目不提供多租户安全沙箱。

MCP 客户端在每次 RPC 前重新读取 `connection.json` 和私有令牌。服务重启产生新令牌后，不需要把令牌复制到豆包；重启期间失败的调用也不会自动重投。连接恢复后先查原任务，需要时调用 `codex_recover` 核对原 Turn。“连接可恢复”不等于“原任务已恢复执行”。

## 图片任务的原图保底

图片生成记录独立保存在任务的 `images[]` 中；没有最终报告或 `result=null` 不代表没有生成图片。已完成的本地原图会复制到工作区 `.doubao-codex/artifacts/<task>/attempt-<n>/`，保留真实格式和原文件，记录文件大小、SHA-256 与 MIME 类型。

图片事件、执行结束和恢复核对会尝试完成保底复制。任务失败或取消后，仍可查询原图记录，并使用 `codex_collect_images {id}` 收集精确 Thread/Turn 中已缓存的原图；此操作不启动或恢复模型、不重新生成、不改变任务执行或验收状态。

保底复制不自动转换为 JPG，也不把 partial/未完成图片当作完成品。最终仍按用户要求的格式、尺寸、数量、命名与内容独立验收，只有 `completed` 任务可被接受。图片任务应为生成、格式处理和验证留出合理期限；默认任务期限为 7,200 秒（120 分钟），用户预算优先，不因超时自动重试或绕过期限。

每任务跨全部返工最多记录 100 个图片项，达到上限会返回 `imageCollectionWarning`，新增图片项不再复制。图片校验限于文件头/容器，不是完整像素或内容验收，也不承诺抵御敌对本地进程的所有并发文件替换。详见 [工具说明](docs/tools.md) 和 [安全边界](docs/architecture.md#权限范围)。

读取或恢复含多张图片的历史会话时，传输层流式省略 `imageGeneration.result` 的内联图像数据，保留完整 Thread/Turn 结构、标识、文字、`savedPath` 和失败信息。它不删除历史、原图或轮次，也不通过只读取最新 Turn 绕开恢复核对。非媒体数据仍有大小限制，异常协议会明确报错；连接健康不代表历史读取或派工一定成功。这项修复不改变 MCP 工具和 Skill，具体行为见 [大图片历史排障](docs/troubleshooting.md#历史图片较多时读取恢复或派工断连)。

## 维护

```sh
node src/cli.mjs call list '{"limit":10}'
node src/cli.mjs call get '{"id":"TASK_ID"}'
node src/cli.mjs call wait '{"id":"TASK_ID","timeoutSeconds":45}'
node src/cli.mjs uninstall
```

CLI 方法名是对应 MCP 名称去掉 `codex_`，详见 [14 个工具的接口说明](docs/tools.md)。服务日志位于状态目录的 `service.log` 和 `service.error.log`。

更新源码不会自动更新已部署服务。在没有排队、执行中或未知状态任务时，更新依赖并测试，再 `uninstall`、`install`。旧部署、数据库、配置、产物和停用的服务文件备份会保留。已经使用固定入口且 Node/状态目录未改变时，豆包参数无需随部署时间戳变化；若 MCP 工具或适配器变化，则重新连接 MCP、刷新工具；仅在 Skill 内容变化时重新导入对应 Skill。首次迁移旧入口时用 `connector-config` 更新一次参数。

更多说明：[架构](docs/architecture.md) · [排障](docs/troubleshooting.md) · [验证记录](docs/verification.md) · [发布检查](docs/release-checklist.md)。

发布前可运行：

```sh
npm run skill:pack
npm run release:check
```

打包命令生成 `dist/doubao-codex-executor.zip` 和 `dist/SHA256SUMS`，用于发布附件；生成文件不纳入源码维护。

仓库另附 [GitHub Actions 模板](docs/ci.example.yml)，尚未启用。维护者可复制到 `.github/workflows/ci.yml` 后提交，以自动运行 Node.js 24 的 macOS / Ubuntu 模拟测试和发布检查。

## 架构参考

本项目借鉴 [codex-workbuddy-gateway](https://github.com/dudu555-djiao/codex-workbuddy-gateway) 的工作区绑定、持久任务、幂等提交和监督返工思路，采用独立实现。没有复制该项目源码，也不把架构参考视为对其代码的许可授权。

## 许可证

本项目采用 [MIT License](LICENSE)。
