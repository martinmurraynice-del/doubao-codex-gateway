# 豆包工作原生接入

本项目使用豆包工作的原生自定义 STDIO 连接器与 Skill 上传功能。已在 macOS 的豆包工作中完成实际工具调用和任务验收，最近一次 Skill 上传与详情核验使用 2.32.3；其他版本的菜单文字、账号开关和本地运行时状态可能不同。

## 注册连接器

先配置并启动 Gateway，再运行：

```sh
node src/cli.mjs connector-config
```

在豆包工作技能中心选择“新建/添加” → “新建自定义连接器”。填写名称 `Doubao Codex Gateway`，传输类型 `STDIO`，并逐项使用命令输出的 `command`、`args` 和 `env`。不要把整条 shell 命令塞进“命令”字段，也不要在参数中再次手工添加 shell 引号。

自定义连接器应在“本地电脑”运行时使用。首次使用可能需要初始化本地环境；若应用显示“本地电脑未初始化”，先完成原生界面要求的初始化。

保存后确认连接器可用、工具列表出现，并在实际工作对话中调用 `codex_health`。项目的内部 HTTP `/rpc` 不是 Streamable HTTP MCP 地址，接入时应选择 STDIO。

安装后的运行代码位于 Application Support 的版本化部署目录，连接器使用固定的 `bin/mcp.mjs` 启动器，启动时通过 `installation.json` 选择当前部署。旧连接器直接指向带时间戳的脚本时，按 `connector-config` 输出迁移一次；后续升级通常只需重连 MCP 并刷新工具列表，不随部署时间戳改参数。Node 路径或状态目录改变时仍需重新核对配置。

当前工作树新增 `codex_collect_images`。安装版仍缺少此工具时，需要更新运行版本并刷新连接器工具列表，源码中的 14 工具文档不能证明已有连接器已更新。Skill 也应上传相应版本；在真正调用成功前，不声称已经收集图片。

## 上传 Skill

豆包技能中心支持上传 `SKILL.md`、ZIP 或包含 `SKILL.md` 的文件夹。技能文件需要 YAML 元数据，包含名称和描述。

- [Skill 源码](../skills/doubao-codex-executor/SKILL.md)
- [最新 Release 的 ZIP](https://github.com/martinmurraynice-del/doubao-codex-gateway/releases/latest/download/doubao-codex-executor.zip)

从当前源码安装时，应在仓库根目录运行 `npm run skill:pack`，上传生成的 `dist/doubao-codex-executor.zip`，或使用同版本 Skill 源文件。Release ZIP 只对应其标签版本，源码推送不会更新已有附件。

选择“上传技能”，已有同名技能时选择替换。等待应用检查完成，在管理界面重新打开 `Doubao Codex Executor` 详情，确认内容已更新且保持启用。连接器和 Skill 的存在本身不是端到端验证；还需让豆包调用工具并核对真实文件。

## 为什么不依赖第三方桌面 CLI

调研过 [doubao-cli](https://github.com/Fullstop000/doubao-cli) 的 README、Skill 和 MCP 源码。其桌面 MCP 注册路径通过 CDP 运行应用内部代码，并可能要求重新启动应用以启用调试。该方案不是本项目的依赖。

本项目使用正常原生 UI 注册。安装包中的连接器管理逻辑支持运行时刷新；实际注册与调用已验证，无需为此引入 CDP。

没有发现可供本项目依赖的、稳定公开的本地 `mcpServers` 配置文件约定。因此不要根据其他客户端的格式臆造豆包配置路径，或直接修改应用的私有数据库。

## 证据和验收

最初通过应用包的技能中心文案、MCP 传输类型与原生运行时刷新代码确认功能，再通过正常 UI 做了真实验证。调研不依赖复制用户凭据、读取私人聊天历史或绕过登录。

接入成功的标准是：豆包实际发现工具，提交一个隔离测试目录中的任务，等待后读取真实产物，检查验收标准，再记录 `accepted` 并汇报。已完成检查见 [验证记录](verification.md)；常见错误见 [排障](troubleshooting.md)。
