# 豆包工作原生接入

本项目使用豆包工作的原生自定义 STDIO 连接器与 Skill 上传功能。已在 macOS 的豆包工作 2.32.3 中完成实际工具调用和任务验收；其他版本的菜单文字、账号开关和本地运行时状态可能不同。

## 注册连接器

先配置并启动 Gateway，再运行：

```sh
node src/cli.mjs connector-config
```

在豆包工作技能中心选择“新建/添加” → “新建自定义连接器”。填写名称 `Doubao Codex Gateway`，传输类型 `STDIO`，并逐项使用命令输出的 `command`、`args` 和 `env`。不要把整条 shell 命令塞进“命令”字段，也不要在参数中再次手工添加 shell 引号。

自定义连接器应在“本地电脑”运行时使用。首次使用可能需要初始化本地环境；若应用显示“本地电脑未初始化”，先完成原生界面要求的初始化。

保存后确认连接器可用、工具列表出现，并在实际工作对话中调用 `codex_health`。项目的内部 HTTP `/rpc` 不是 Streamable HTTP MCP 地址，接入时应选择 STDIO。

安装后脚本位于 Application Support 的版本化部署目录。`connector-config` 通过 `installation.json` 找到正确路径。重装网关会产生新路径，应重新生成并更新连接器参数。

## 上传 Skill

豆包技能中心支持上传 `SKILL.md`、ZIP 或包含 `SKILL.md` 的文件夹。技能文件需要 YAML 元数据，包含名称和描述。

- [Skill 源码](../skills/doubao-codex-executor/SKILL.md)
- [最新 Release 的 ZIP](https://github.com/martinmurraynice-del/doubao-codex-gateway/releases/latest/download/doubao-codex-executor.zip)

选择“上传技能”，等待应用检查完成，在管理界面确认 `Doubao Codex Executor` 可用。连接器和 Skill 的存在本身不是端到端验证；还需让豆包调用工具并核对真实文件。

## 为什么不依赖第三方桌面 CLI

调研过 [doubao-cli](https://github.com/Fullstop000/doubao-cli) 的 README、Skill 和 MCP 源码。其桌面 MCP 注册路径通过 CDP 运行应用内部代码，并可能要求重新启动应用以启用调试。该方案不是本项目的依赖。

本项目使用正常原生 UI 注册。安装包中的连接器管理逻辑支持运行时刷新；实际注册与调用已验证，无需为此引入 CDP。

没有发现可供本项目依赖的、稳定公开的本地 `mcpServers` 配置文件约定。因此不要根据其他客户端的格式臆造豆包配置路径，或直接修改应用的私有数据库。

## 证据和验收

最初通过应用包的技能中心文案、MCP 传输类型与原生运行时刷新代码确认功能，再通过正常 UI 做了真实验证。调研不依赖复制用户凭据、读取私人聊天历史或绕过登录。

接入成功的标准是：豆包实际发现工具，提交一个隔离测试目录中的任务，等待后读取真实产物，检查验收标准，再记录 `accepted` 并汇报。已完成检查见 [验证记录](verification.md)；常见错误见 [排障](troubleshooting.md)。
