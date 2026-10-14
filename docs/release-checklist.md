# v0.1.0 发布检查

此版本是面向单用户本机使用的实验性工具，不是托管服务或多租户平台。

## 可复现检查

从仓库根目录运行（Node.js 24+，Git，系统 `zip` / `unzip`）：

```sh
npm ci
npm test
npm run release:check
npm run skill:pack
unzip -t dist/doubao-codex-executor.zip
```

`release:check` 检查 Git 已跟踪文件、必需文档、相对链接，以及常见私人路径、凭据和运行数据的误提交。它是启发式检查，不替代人工审查或完整秘密扫描。维护者新增文件后先暂存，再运行它。

`skill:pack` 仅打包 `skills/doubao-codex-executor/SKILL.md`，输出 ZIP 和 `dist/SHA256SUMS`。它不会打包配置、数据库、运行日志或本机安装记录。`dist` 不加入 Git；成品作为 GitHub Release 附件分发。

## 本次验证范围（2026-10-14）

- 本机 50 项自动化测试通过，包括新增的 CLI 参数、目录与安装记录校验。
- 本次 `npm audit --omit=dev --audit-level=high` 返回 0 vulnerabilities；这是运行时的依赖数据库快照，不保证未来不会披露新漏洞。
- Skill YAML 元信息通过 Skill Creator 验证器；打包内容与源码对应。
- 原始实现完成真实 Codex 执行、服务重启后的同会话返工，以及豆包原生 STDIO 连接器提交、读文件和独立验收。详见[验证记录](verification.md)。发布文档和 CLI 可移植性整理后未重装现有后台服务，不能把既有端到端证据当作所有新机器兼容性证明。
- 本次只读代码审查核对了回环鉴权、真实路径校验、事务幂等、不确定结果不自动重放及显式模型传参；不构成第三方安全审计。
- 提供 [GitHub Actions 配置模板](ci.example.yml)，用于 Ubuntu / macOS、Node.js 24 上的模拟测试、发布检查及 ZIP 完整性检查。首次发布使用的 GitHub 授权不含工作流写入权限，因此模板未启用，未宣称 CI 已运行。维护者可自行将模板复制到 `.github/workflows/ci.yml` 后提交；这不等于跨平台真实 Codex / 豆包端到端测试。

## 必须保留的限制

- 仅 macOS 原生安装流程得到真实验证；Windows 不在本版本支持范围，Linux 无 LaunchAgent 安装器。
- 不内置 Codex 账号或模型权益，不保证模型目录中的每一项对当前账号可调用。
- `allowedRoots` 和 `workspace-write` 不是完整读取隔离；仅连接可信的本机客户端，不开放公网，不用于不受信任的多用户任务。
- 机器休眠、关机和服务停止会影响执行；SQLite 持久化不代表离线继续计算。`uncertain` 必须核对，不能重投绕开。
- 豆包会话结束后不自动唤醒、验收或通知；不承诺任务显示在 Codex 桌面侧栏。
- 默认不提供总队列大小、磁盘用量和 token 费用配额；持续使用需自行管理任务、日志和预算。

## 升级与回退

先记录版本与 `node src/cli.mjs paths` 输出，确认没有排队或占用容量的任务。只停止网关不会撤销已经发生的项目修改。停服后备份配置、SQLite 状态目录、安装记录和实际工作区；备份包含隐私，不可提交到 GitHub。

本版本没有自动数据库降级工具。升级前阅读目标版本说明；需要回退时停止新服务，恢复与旧代码版本配套的状态备份，再运行旧版本服务并重新生成连接器配置。不要让两个版本同时使用同一状态目录，不要删除数据库来消除不确定任务。

`uninstall` 只卸载 LaunchAgent 注册，并保留配置、任务状态、产物及停用的 plist 备份。详细操作见[排障说明](troubleshooting.md)。
