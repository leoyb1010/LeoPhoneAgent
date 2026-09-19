# leocodebox 2.0.0(2026-09-19)

> 从"包装多个 CLI 的 IDE 壳"改成"一条能在任何设备上续写的会话流水"。内核换成应用自带的 pi 运行时;界面只剩主控、设备、通道、设置和 ⌘K。

## 用户看得到的

- **全新界面**:左栏是按机器分组的会话流水(状态点 · 标题 · 模型 · 最后一件事 · 时间),中间是当前会话的运行流水(你 / 模型 / `$ 工具` / 编辑 / 需要确认 / 系统行),会话头和输入区是悬浮玻璃。别的会话有待批时,顶部出现一条可直接跳转的「需要你」橙色条。终端 / 文件 / 本次改动 / 浏览器全部改成右侧抽屉。
- **审批卡**与 iPhone 同名同义:批准一次 / 本会话允许 / 拒绝;卡上写明「绑定:主机 + 这条完整命令,改一个字都要重新批准」。
- **换模型不换会话**:会话头点模型 chip 直接切,上下文不变。审批策略四档随时切。
- **模型全接**:设置页列出 pi-ai 全部供应商(41 家)。Anthropic(Claude Pro/Max)、OpenAI Codex(ChatGPT 订阅)、GitHub Copilot、OpenRouter 走 OAuth 登录;智谱 GLM、Moonshot / Kimi、xAI、DeepSeek、Google 等粘贴密钥;任意 OpenAI 兼容端点也能加。
- **Telegram 通道**:设置 → 通道 填 bot token,生成配对码,在聊天里发 `/pair 123456`;之后说一句话就是在这台 Mac 上开会话,需要确认的操作会以同一张卡(内联按钮)推到 Telegram。
- **删除**:任务、PRD、项目向导、missions、Agent Hub、skills、plugins 七块与旧 IDE 壳。中继 / 语音 / MCP / 通知等旧版设置从设置页「更多设置」进入。
- **首次进入**:先在设置里登录或添加一个密钥,否则新会话会报"没有可用凭据"。

## 底下换了什么

- `@earendil-works/pi-coding-agent` 的 rpc-entry 打进应用,用宿主 Node(Electron as Node)直接跑;事件走既有 `pi_rpc` 方言进 HarnessSession 日志(NDJSON + 单调 seq),iOS / relay / 渲染层协议一字不改。
- 审批由 `~/.leoagent/pi/extensions/leo-approval.ts`(应用生成)在 pi 的 `tool_call` 钩子里按策略发起 `select`;「本会话允许」= sha256(host | cwd | tool | 命令) 落在 `~/.leoagent/pi/policy/<会话>.json`。
- 修正 `pi_rpc` 方言与真实协议的偏差(select 读 `options` 答 `value`,confirm 答 `confirmed`;prompt 被拒 → run.failed)。
- 新增 `/api/leophone/local/*`(本机会话直连,与手机同一套事件)、`/api/leophone/pi/*`(供应商、密钥、OAuth 登录流程)、`/api/leophone/channels*`(Telegram)。
- 会话摘要新增 `title / last_event / created_at / updated_at`,iOS 列表也读这些字段。
- 删除服务端 taskmaster 模块与插件子进程加载器;前端组件文件 273 → 105。

## 验证

- 单测 31/31(leophone + pi-runtime);server / client tsc 通过;vite build 通过。
- 本地 mock 模型(`scripts/mock-openai-server.mjs`):创建 → 审批卡 → 批准一次 → 执行 → 完成;本会话允许后同命令免问;计划模式拦截并把原因回给模型;拒绝可送达。
- 浏览器里(vite + 隔离 LEOAGENT_HOME 的服务):新建会话 → 审批卡 → 批准 → 完成;设备 / 通道 / 设置三页;明暗主题;终端抽屉。
- Telegram mock(`scripts/mock-telegram-server.mjs`):配对 → 开会话 → 审批卡 → 按钮 → 回执 + 编辑原消息 → 完成回复。

## 发布

Developer ID Application 签名 + Apple 公证 + Stapler 钉章后上传 `leoyb1010/leocodebox-updates`(`v2.0.0` + `latest-mac.yml` + ZIP + DMG)。装机后首启必须弹出「本次更新 · 2.0.0」。
