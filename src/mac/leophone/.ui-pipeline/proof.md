# LeoBot Mac 工作台 · 实装证据

2026-11-14，Pro 本机，canonical main（改造基线 7dd6115b2）。实现及个人四机安装验收 PASS；公开发布未进行。

## 渲染与流程

- `scripts/leo-workbench-smoke.mjs`：生产 Electron + 确定性模型 fixture。真实 Host、Write 工具、文件、IPC 和原生保存，不调用真实模型账户。最终 16 项检查通过，pageerror 为空，网络/自导航探针外联 0 次。
- 1440×900、1280×800、600×800；明暗主题、reduced motion；Agent 键盘 Escape / 焦点返回 / Enter 重开。
- 实际路径：选择 Agent → HTML 起步项填入草稿 → 创建真实文件 → 完成消息 → HTML 静态/交互/源码 → 原文保存 → 同一任务草稿追加修改。
- 95+ 是目标，未取得独立设计评分。截图内容是测试项目，不能作为真实业务成果。
- 主进程只维护窗口归属的有界短期预览句柄；不承载 task/session 业务。独立 leo-html 文档允许明确授权的内联脚本，主窗口 script-src 未放宽。最终探针中产物与主窗口 processId 不同；这不是完整资源隔离审计。

## 自动检查

- 最终影响范围：20 个文件，216 项通过，14 项平台条件跳过。
- 末轮定向：5 个文件 72 项通过（含重叠用例，不与前数相加）。
- bundled skills：6 项通过；ACP Node 桥接：19 项通过。
- typecheck 通过；lint 退出 0，0 错误、76 警告；architecture changed 0/0/0；tokens 一致；1.21.0 更新说明 4 条有效；diff whitespace 通过；source redline 6012 文件 0 命中。
- Agent 运行时重新构建和 prepare 成功；生产 Electron 构建成功。关闭 E2E store bridge 后独立启动检查通过，两个测试接口均 undefined。

## 独立真实模型证据与限制

- 本机 Codex CLI 0.167.0 独立生成离线 HTML，真实 Chrome 点击两次计数 2、pageerror 为空；与上述 fixture 集成流程分开。
- 生产 LeoBot 选择本机 Codex CLI，真实 ACP 任务 28 秒完成并写出 HTML；恢复任务后点击正文文件按钮进入新产物，明确运行脚本并点击两次计数为 2。两个测试 store 接口均 undefined；见当前聊天 work/implementation/native-product-resume.log。旧 HTML 消息链接浏览器分支已移除，正文与卡片一致。
- 本机 Claude Code 2.1.318 返回 OAuth expired；没有更改其认证配置，真实模型任务未通过。目录可用不代表认证有效。
- Air：边界审查 j-2edf1109f90100022b0c0293；唯一实际代码审查 j-68a65351bed5847841e40d9d。请求/执行 claude-opus-5-5-ga，报告 claude-opus-5-5；无 fallback。无阻断项，生命周期/目标/离线依赖建议已落实。未声称 Air 运行 GUI 或给出设计分。

## 交付边界

- 首阶段交付独立预览；后续按明确授权完成 1.21.0 签名、公证和个人四机覆盖，逐台验证后清理 App 副本。源码构建 ae4903ec0；完整发布门禁与安装证据见仓库 docs/mac-3.0/RELEASE-1.21.0.md。未公开发布或推送。
- HTML 预览是 1MiB 内完整离线单文件；复杂工程继续使用原工程工具链。未在本阶段接入实验 Harness 或新增 Office 转换。
- 证据目录：当前聊天 `work/implementation/workbench-link-final`。面向用户的截图/HTML验收与启动器位于当前聊天 outputs。
