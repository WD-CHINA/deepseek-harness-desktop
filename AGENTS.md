# DeepSeek Harness Desktop Agent Guide

本文约束在本仓库中工作的 AI Agent、自动化工具和贡献者。目标是在不破坏 Harness 兼容性、桌面安全边界和跨平台生命周期的前提下，以最小改动完成需求。

## 1. 项目定位

- 本项目是 `@deepseek-ai/dsh` Web UI 的 Electron 桌面宿主，不是 Harness 的 fork。
- Electron 主进程负责启动 Harness、解析回环地址、创建安全窗口、处理异常和清理进程树。
- 支持矩阵为 macOS arm64、macOS x64 与 Windows x64。Linux 配置尚未纳入 CI 验收。
- 应用身份必须保持稳定：
  - `appId`: `com.harness.deepseek-harness-desktop`
  - `productName`: `DeepSeek Harness Desktop`
  - 初始版本：`0.0.1`

## 2. 开始修改前

1. 阅读 `package.json`、相关 `src/*.ts`、同目录测试和 `docs/RELEASING.md`。
2. 用 `git status --short` 确认现有改动，不覆盖或清理不属于本任务的内容。
3. 总结需求目标、数据/进程流程、影响文件、验收标准和风险后再编码。
4. 优先复用现有模块与测试结构，禁止无关重构。

## 3. 必须保持的边界

### Harness 兼容性

- `@deepseek-ai/dsh` 必须使用精确版本并提交 `package-lock.json`，不要改成 `^`、`~`、`latest` 或运行时安装。
- 不要依赖用户电脑预装 Node.js 或全局 `dsh`；必须继续使用 Electron 内置 Node.js。
- 升级 DSH 前检查包内 CLI 入口、`dsh web` 参数、ready-line 输出和运行目录行为。
- DSH 升级必须独立提交，避免与 Electron、构建工具或页面改版混在一次升级中。

### 安全

- Harness 地址必须匹配 `http://127.0.0.1:<port>`，不得接受 `0.0.0.0` 或任意远程地址。
- 保持 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true` 和 `webSecurity: true`。
- 主窗口只允许 Harness 同源导航；外部打开仅允许 HTTP(S)，禁止 `file:`、`javascript:` 等协议。
- 默认拒绝 Web 权限请求。若新增权限，必须说明业务原因、限制来源并增加测试。
- 不在仓库、日志、页面或构建产物中写入凭据、证书、邮箱、个人路径和 Token。

### 进程生命周期

- Windows 需要使用 `taskkill.exe /PID <pid> /T` 清理进程树，强制退出时增加 `/F`。
- macOS/Linux 使用独立进程组，先 `SIGTERM`，超时后再 `SIGKILL`。
- 保持单实例行为；处理第二实例、窗口重建、应用退出、启动超时和 Harness 意外退出。
- 所有新增异步启动/停止逻辑都要考虑重复调用、竞态、超时和资源释放。

### 打包与签名

- macOS 与 Windows 必须在各自原生 GitHub runner 上打包，不做跨平台正式构建。
- 不允许通过关闭 `forceCodeSigning` 或跳过公证来伪造正式 Release 成功。
- 签名证书只能通过 GitHub Actions Secrets 注入，不能生成或提交自签名证书替代生产证书。
- `asar: true`，必须 `asarUnpack: ["**/node_modules/**/*"]`；由 `dsh-node-entry` 从 `app.asar.unpacked` 加载 DSH，保证 profile 软链目标是真实路径（勿依赖 `fs.symlinkSync` 补丁，ESM named import 不受影响）。
- macOS entitlements 必须包含 `com.apple.security.cs.disable-library-validation`，否则 Hardened Runtime 会拒绝加载插件带来的第三方 `.node`（Team ID 与应用不一致）。

## 4. 开发流程

安装与基础验证：

```bash
npm ci
npm run verify
```

涉及运行时或生命周期的修改，还应执行：

```bash
npm start
npm run pack
```

涉及官网的修改：

```bash
npm run pages:build
python3 -m http.server 4173 --directory _site
```

不要手工修改 `dist/`、`release/` 或 `_site/`；它们都是生成目录。

## 5. 测试与验收

核心代码必须覆盖或检查以下场景：

- 正常启动、随机端口解析、60 秒启动超时和启动失败。
- 空输出、分段输出、超长诊断输出以及意外退出。
- 同源导航、外部 HTTP(S) 链接和危险协议拒绝。
- 重复启动、第二实例、重复关闭和退出期间的异步竞态。
- Windows 进程树普通/强制终止，macOS 进程组普通/强制终止。
- 应用关闭后无 Harness、Node、PowerShell 或终端子进程残留。
- 工作区为空、路径包含空格、路径不存在或无权限时给出可理解错误。

只在实际运行相应命令或目标平台验证后，才能声称测试或打包通过。macOS 本机验证不能替代 Windows CI 结果。

## 6. DSH 升级清单

1. 阅读目标版本 release notes 与包内容差异。
2. `npm install --save-exact @deepseek-ai/dsh@<version>`。
3. 检查 `require.resolve('@deepseek-ai/dsh/package.json')` 后的 CLI 路径仍有效。
4. 更新 ready-line/参数兼容测试，运行 `npm run verify`。
5. 本机执行开发启动和未压缩打包验证。
6. 等待 macOS arm64、macOS x64、Windows x64 原生 CI 全部通过。
7. 人工验证工作区、任务、设置、会话、外链和退出清理。
8. 通过版本标签触发签名 Release，不直接上传未签名公开安装包。

## 7. 文档与提交

- 行为、命令、平台支持或 Secrets 变化时同步更新 `README.md` 与 `docs/RELEASING.md`。
- 官网只修改 `site/`，由 `scripts/build-pages.mjs` 产出 `_site/`。
- Commit Message 使用简洁中文或 Conventional Commits，例如：`feat: 添加 GitHub Pages 官网`。
- 提交前检查 `git diff --check`、`git status --short` 和 `npm run verify`。
- AI 生成代码必须由人工审查；重点检查空值、权限、异步竞态、内存/进程泄漏、安全边界和跨平台差异。

## 8. Code Review 清单

- [ ] 修改范围与需求一致，没有无关重构。
- [ ] DSH 版本精确锁定，锁文件同步更新。
- [ ] BrowserWindow 安全配置和导航限制未弱化。
- [ ] 启动、异常、超时、重复操作和退出路径均可收敛。
- [ ] Windows 与 macOS 生命周期语义都被覆盖。
- [ ] 不包含证书、Token、邮箱、绝对个人路径或敏感日志。
- [ ] 类型检查、单元测试、构建及相关打包验证有真实记录。
- [ ] README、发布文档和官网与代码行为一致。
