# Paperclip 服务器工作区（开发分支）

本分支把当前 Mac 主工程 `src/mac/leophone` 的首屏改为 Paperclip 原生任务工作区；iOS 保留本机模式，并增加可选的 Paperclip 工作区。服务器独立运行，任务在服务器配置的执行环境中执行。此分支不代表安装包发布，也没有部署到任何真实服务器。

## 代码与来源

- LeoPhoneAgent 基线：`2fa9b001bd4bd38c1c1bdcecffb34f29dac512b0`
- Paperclip 固定版本：[`994d6edcdd4e15d5f9cc5cf8c135ac599104b86a`](https://github.com/paperclipai/paperclip/tree/994d6edcdd4e15d5f9cc5cf8c135ac599104b86a)
- Mac 原生传输：`src/mac/leophone/packages/desktop/src/main/paperclip`
- Mac 业务后端、状态及回执：`src/mac/leophone/packages/services/src/paperclip`
- Mac 中文工作区：`src/mac/leophone/packages/ui/src/paperclip`
- iOS 客户端和工作区：`src/ios/Agent/Paperclip`、`src/ios/Views/Paperclip`
- 服务器中文源码发行层：[`src/server/paperclip`](../../src/server/paperclip)，包含固定版本清单、可审查词库、源码转换/检查脚本、MIT 原许可及部署材料

不将 Paperclip 嵌入现有 relay，不用修改 gateway URL 的方式冒充新后端。旧 GatewayHostStore、LeoAgentHarness、本机记忆和工具与 Paperclip 分开。

## 统一术语

三端显示统一使用：Company → 组织、Agent → 智能体、Issue/Task → 任务、Run → 运行、Approval → 审批。API 字段/枚举和用户自定义名称不翻译；网络代理（proxy）与智能体不是同一个概念。

## 使用路径

1. 先依服务器目录的中文部署说明准备 Paperclip 服务，使用 HTTPS 和 `authenticated` 模式。远程公开服务不能使用无认证的 `local_trusted` 模式
2. 在服务器中文后台完成首位管理员、组织和智能体配置。执行命令、工作目录和模型供应商凭据留在服务器，客户端不要求填写智能体 API 密钥
3. Mac 打开默认工作区，保存服务器地址，点击“登录服务器”。在隔离的服务器登录窗口中用人类账号登录，返回后选择组织
4. 创建任务并指派服务器智能体；读取任务状态、回复、运行记录和日志，按需处理审批、取消运行、查看文档和下载附件
5. iOS 从设置选择 Paperclip 工作区并登录；默认仍是本机模式。切换不会搬迁或改写已有本机会话

服务器地址只接受 origin，例如 `https://paperclip.example.com`，不能带 `/api`、账号口令、查询参数或 fragment。HTTP 仅供明确指定的本机回环开发地址使用。

## 安全与失败语义

- 人类操作者使用 Better Auth Cookie 会话；智能体 API key/JWT 不能代替管理员登录。Cookie 不进入 Mac renderer/普通偏好设置，也不打印日志
- 任务身份绑定服务器 origin、组织和登录用户；切换服务器/账号/组织不会把旧任务或待确认操作迁移到新环境
- Mac 默认不会启动本机 Host/Agent/本机定时任务。用户明确进入“本地恢复模式”才启用旧入口；返回服务器不会强杀用户此前明确启动的本机会话
- 网络断开、超时、HTTP 5xx 或丢失回执不能证明操作没发生。两端保留待确认操作并阻止重复点击；不自动切回本机执行
- 创建任务使用上游 `idempotencyKey`；回复使用 `clientRequestId`。上游创建任务去重记录仅保留 **7 天**，客户端采用更保守的 **6 天**可重放窗口，过期后必须先人工核实，不能用新 ID 自动重发
- 取消/审批/状态更新不假设服务端普遍支持幂等。先读回相同任务/运行/审批对象核实，不能看到 POST 2xx 就宣称远端执行完成
- 高级后台功能保留为服务器自己的完整网页管理界面。它和客户端共享中文术语，但并非将整个英文网页嵌入应用来代替原生工作区
- 用户任务、模型输出、命令和原始日志原样保留，可能包含英文。错误提示用中文解释，技术诊断单独呈现

## 可执行验证

从仓库根目录：

```sh
python3 scripts/IOSPaperclipContractAudit.py
python3 scripts/PaperclipUpstreamContractAudit.py /path/to/pinned-paperclip
bash -n scripts/native-paperclip-audit/run.sh
# macOS + Xcode 26.6 + xcodegen + iOS 26.5 Simulator
bash scripts/native-paperclip-audit/run.sh
```

从 `src/mac/leophone`：

```sh
pnpm install --frozen-lockfile
pnpm --filter '@zcode/contracts...' build
pnpm typecheck
pnpm lint
pnpm architecture:check
node scripts/paperclip/typecheck-transport.mjs
node --import tsx --test packages/desktop/src/main/paperclip/*.test.ts
node --import tsx --test packages/services/test/paperclipWorkspace.test.ts
node node_modules/playwright-core/cli.js install chromium
node scripts/paperclip-ui/run.mjs
```

中文服务器检查命令以其目录内说明为准。语言覆盖报告同时给出已替换字符串和仍待人工处理的候选清单；不把扫描候选数量视为完成翻译的数量。

## 验证与交付边界

源码/契约单测、真实 Apple 编译/模拟器、前端浏览器场景、真实服务器端到端是四个不同层次。CI 工件保留日志、结果包和截图；每个提交的通过/失败/未运行结论单独记录。界面假数据不能证明真实账号、模型计费、服务器 CLI 或部署可用。

当前不交付签名安装包、不合并主分支、不自动配置服务器、不复制密钥或生产数据。远程 Mac worker 接入服务器调度、跨端本地会话迁移、推送通知及服务器离线运行恢复不在此分支的一期执行路径中。
