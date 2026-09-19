# leocodebox 2.0 落地进度(供续接会话使用)

分支:`mac/2.0-pi`(自 main@126722d7)。方案与 demo:`~/Desktop/leocodebox-重设计/`(方案.md / demo.html v2 / demo-v1.html)。

## 已拍板
- 模型:pi-ai 全接,含 OAuth 订阅登录(Anthropic / OpenAI Codex / GitHub Copilot / OpenRouter)
- 删除:task-master / prd-editor / project-creation-wizard / missions / agent-hub / skills / plugins(删前导出 Markdown)
- 通道:Telegram 先做
- 界面:demo v2(悬浮玻璃、iOS 同名能力、LeoMotion 时长)

## 架构事实(已核实)
- 服务端已有 harness 层:`server/modules/leophone/harness-session.service.ts`(HarnessSession:journal NDJSON + 单调 seq + subscribe(after) + pendingApprovals;HarnessManager:create/list/get)
- 归一化事件词汇:message.delta / reasoning.available / tool.started / tool.completed / approval.request / approval.responded / user.message / session.created / run.completed / run.failed / run.cancelled
- **已有 `pi_rpc` 方言 + `HARNESSES.pi`(spawn `pi --mode rpc`)** —— 2.0 的内核路线:把 pi 的 rpc-entry 打进应用自带运行时,用 Node 直接跑,不依赖外装 CLI;事件走既有方言,iOS / relay / 渲染层协议不变
- 审批:pi 内置工具默认不问;需要一个 pi extension 在 `tool_call` 钩子里按策略 `ctx.ui.confirm/select` → RPC `extension_ui_request` → 方言 → approval.request;策略与「本会话允许」scope 走文件(服务端写,extension 每次读)
- REST(iOS 同用):GET/POST /harness/sessions,GET /harness/sessions/:id/events?after=N(SSE),POST …/send /stop /approval;GET /leophone/fleet;setHarnessEventSink 供 relay/通道推送
- 渲染层现状:React18 + Vite + Tailwind + react-router;273 组件;聊天走另一条 chat-run-registry/WS 管线(2.0 统一到 harness 事件)
- pi 包已装:@earendil-works/pi-coding-agent@0.85.1 / pi-agent-core / pi-ai(node ≥22.19;本机 22.22)

## 阶段
- [ ] 0 PoC:pi 内置运行时 + 审批 extension + REST 跑通 + iPhone 经 relay 看到并批准
- [ ] 1 新壳:主控 / 设备 / 通道 / 设置 + ⌘K + 抽屉(React,src/v2)
- [ ] 2 迁移与删除
- [ ] 3 Telegram
- [ ] 4 发版:bump 2.0.0-alpha.1 + LEO_RELEASE_NOTES + 签名公证 + 装机 + 热更新

## 验证记录
(逐步追加)
