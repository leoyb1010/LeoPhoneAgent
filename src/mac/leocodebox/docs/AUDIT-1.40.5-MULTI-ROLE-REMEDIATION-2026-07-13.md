# leocodebox v1.40.5 多角色对抗复审

复审日期：2026-07-13<br>
基线报告：`docs/AUDIT-1.40.4-MULTI-ROLE-2026-07-13.md`<br>
结论：**原报告 5 项 P1 与 7 项 P2 已完成修复，并通过源码、隔离环境、正式 App、Developer ID 签名、Apple 公证和 GitHub 发布六层验证。**

## 修复闭环

| 原问题 | 修复结果 | 验证证据 |
|---|---|---|
| 全新设备 CLI 发现受宿主机污染 | 显式 Agent PATH 优先，并保留登录 Shell 与兜底路径 | clean-device 七类 CLI 通过；正式 App 临时 HOME 七类 CLI 通过 |
| 浏览器正式包不可用且修复会改写 App | 随包提供 headless Chromium，修复目录迁至用户目录 | 打包 App `available=true`，真实 Session `ready` |
| lint 失败 | 通过模块 barrel 导出 | ESLint 0 警告 |
| 红色关闭只隐藏窗口 | 关闭触发真实 quit | 实际点击红色按钮后进程退出、38473 释放 |
| Leoapi 备份不可辨认 | 返回并展示 Agent、文件、时间、大小和目标路径 | 服务端测试与页面渲染通过 |
| MCP token 暴露于 argv | 改用 `0600` 文件 | 正式 App 临时 HOME 权限实测 `-rw-------` |
| 冲突副本进入包 | 删除 5 个源码副本；拦截源码副本并自动清理依赖副本 | 最终正式 App 冲突副本为 0 |
| 视觉资产仅堆在目录 | 合格素材映射到启动、工作台、关于、Leoapi、纹理、README、DMG | 浅色/深色截图通过 |
| 设置入口分裂与标签截断 | 顶栏设置进入统一设置中心，标签可横向滚动 | 1152x780 截图通过 |
| 浏览器 URL 显示登录页 | App 生成两分钟单次授权，交换后清除 URL | 首次 200、复用 403、页面无 401 |
| 端口仍写 3001 | 文档与 MCP 兜底统一 38473 | 源码扫描无旧端口 |
| 旧 CloudCLI LaunchAgent 冲突 | 精确识别、停用并改名保存 | 桌面单测通过 |

## 多角色结论

| 角色 | 结果 | 复审重点 |
|---|---|---|
| 新设备首次用户 | 通过 | 免 leocodebox 登录、空状态、七类 CLI 发现、浏览器开箱可用 |
| 新手 | 通过 | 中文默认、设置入口统一、安装提示和错误目标明确 |
| 熟练与重度用户 | 通过 | 会话、终端、文件、Git、审计、统计、Leoapi、备份恢复链路完整 |
| Claude Code / Codex / OpenCode / Cursor | 通过 | 本机命令、认证状态、模型/权限/MCP/Skills 与会话能力保持 |
| Gemini / Hermes / Grok | 通过本机发现与状态管理 | 非完整聊天 Provider 的能力边界保持明确，不伪装成完整 Provider |
| Leoapi 用户 | 通过 | 导入、模型读取、测速、应用、回退、备份与恢复信息可辨认 |
| 浏览器 Agent 用户 | 通过 | 正式包运行时、自修复目录、MCP 凭据和真实 Session 均通过 |
| 安全与隐私 | 通过 | 127.0.0.1、能力 token、单次链接、argv 无密钥、诊断脱敏 |
| 发布与运维 | 通过 | lint/typecheck/tests/build/clean-device/audit/package/sign/notarize/release 均通过 |
| UI 与可访问性 | 通过，保留素材限制 | 浅深色统一、窄窗口无截断；不合格棋盘格素材已排除 |

## 视觉资产审查说明

`public/visuals` 中部分 empty-state、Agent 和 update PNG/WebP 并不是真透明图，而是把透明棋盘格直接烘焙进像素。它们在浅色界面出现明显格子，判定为不合格源资产，未强行用于产品。运行时采用无瑕疵的 launch、onboarding、release、texture 与 DMG 资源；PNG 母版不重复加载，WebP 作为交付格式。

## 验证统计

- 自动测试 254/254：desktop 24、client 40、server 190。
- `npm run lint`、`npm run typecheck`、`npm run build` 全部通过。
- `npm run test:clean-device` 通过；`npm audit --omit=dev` 为 0。
- 打包目录 App 版本、原生模块 ABI、Browser Session、七类 CLI、红色关闭释放端口全部通过。
- 最终 `1.40.5` DMG 与 App 的公证票据、Gatekeeper、深层签名验证全部通过；GitHub 资产摘要与本地 SHA-256 一致。
- 截图位于 `docs/audit-1.40.4/screenshots/fixed-*.png`。

## 残余边界

- 当前正式分发目标仍是 macOS Apple 芯片；Intel 与 Windows 未作为本轮发布平台。
- Agent 的服务商登录、额度和网络可用性属于各 CLI 自身条件，本地发现成功不等同于服务商账号可用。
- 带棋盘格的生成素材需要重新生成真正透明版本后，才适合补入更多高频空状态。
