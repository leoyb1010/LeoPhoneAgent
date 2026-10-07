# 服务端页面可用性审计（发行层 1.1.8，2026-10-07）

目标：确认 Paperclip 中文服务端的每个页面进入后都可用，并把发现的问题修在发行层。本文记录方法、结论与证据；线上数据清理另见 `LIVE_DATA_CLEANUP_20261007.md`。

## 方法

- 从固定提交 `994d6ed` + 三层叠加构建候选，在隔离 `HOME`/`PAPERCLIP_HOME` 下用内嵌 PostgreSQL 真实启动两套实例：`local_trusted`（127.0.0.1:44100）与 `authenticated/private`（127.0.0.1:44101，注册两名用户，首位认领实例管理员，另一名为无组织成员身份的普通用户）。
- 通过 API 造数：组织、2 个项目、2 个目标、标签、SSH 运行环境、9 个不同适配器的智能体（claude_local / codex_local / hermes_local / cursor_cloud / gemini_local / grok_local / http / process / paperclip_runner）、7 种状态的任务（含子任务、阻塞、评论、CSV/PNG 附件）、4 类审批、2 个例行任务（schedule + webhook 触发器）、2 个技能、密钥、15 条费用事件、预算。
- Playwright（上游 `node_modules` 的 playwright 1.62 + 本机 Chromium headless shell 1228）逐路由访问 App.tsx 中的全部路由（含重定向、深链接、不存在的 id、404）：记录最终 URL、控制台错误、pageerror、同源 4xx/5xx、React 错误边界文本、404 文本；三种身份各 155 条，共 465 条。
- 流程脚本覆盖：新建任务、ESC、评论发送并在第二个标签页经 WebSocket 实时到达、状态切换、更多操作菜单、附件上传/下载、审批批准/拒绝/要求修改/评论、例行任务立即运行/暂停、命令面板、搜索与 `status:` 过滤、看板/列表、后退/前进/深链接刷新、智能体向导、配置页“运行测试”、暂停/恢复、项目/目标/密钥/技能创建、实验开关、组织设置保存、预算更新、费用页、审计运行页、收件箱、注销后重定向与再登录、无组织成员的退出登录、原生 CLI 授权页批准、删除组织。
- 证据目录：`<scratchpad>/pc-ui-B/`（`route-matrix.json`、`flows-*.json`、`shots/`、服务日志）。线上站点只做无登录只读检查：`/api/health`、首页与静态资源响应头、WebSocket 升级探测。

## 发现与处理

| 严重度 | 页面/范围 | 问题 | 处理 |
|---|---|---|---|
| 高 | 组织设置 → 删除组织 | 组织含“目标↔项目”或预算策略时 `DELETE /api/companies/:id` 500（`projects.goal_id`、`budget_policies.company_id` 外键无级联，上游删除顺序/清单不完整） | 已修：先删项目再删目标；同一事务内按 `information_schema` 枚举所有带 `company_id` 的表做 savepoint 清扫（`native/server/services/company-deletion-sweep.ts`） |
| 高 | 未登录/无权限访问任意页面 | `/api/instance/settings/experimental`、`/api/adapters` 403 被 React Query 指数重试 3 次，未登录用户停在“正在加载…”约 7.5 秒才跳登录页；不存在的任务/智能体/目标/项目页空白约 7 秒；线上日志出现成批 403/401/404 | 已修：QueryClient 默认 `retry` 对 401/403/404 不重试（跳转与“未找到”均 <0.5 秒，403 由 3 次降为 1 次） |
| 高 | 已登录但无组织成员身份的账号 | “没有组织访问权限”页没有任何操作，无法退出登录切换账号 | 已修：增加“退出登录”按钮（复用 `useSignOut`），验证退出后回到登录页 |
| 中 | 已取消/已完成任务页 | 遗留恢复记录（`evidence.automaticRecovery.replay='blocked'`）使横幅“需要恢复处理 / N 条消息正在等待恢复处理”与恢复卡片永久显示；等待恢复的已保存消息永不收尾；`recovery-actions/resolve` 404、`wakeup` 409 | 已修：前端对 done/cancelled 不渲染恢复横幅与恢复卡片；服务端在任务转为 cancelled 时把 `deferred_issue_execution` 唤醒改为 cancelled 并写活动记录（`issue.deferred_wakes_cancelled`）。线上历史数据按清理程序处理 |
| 中 | 任务详情（进行中且空闲） | `live-runs`/`active-run`/`runs` 每秒各 1 次轮询，每个打开的任务页每秒 3 个请求（线上 10 分钟 554 次请求的主因；实时事件本已由 WebSocket 推送） | 已修：空闲时放宽到 5 秒，有活动运行时仍为 1 秒；本地实测 20 秒内请求由 65 降到 13 |
| 中 | 审计 → 时间线 | 已终止/已删除的智能体仍计入“智能体”数量，与智能体页不一致 | 已修：服务端为时间线 actor 增加 `archived`，前端不计数并在行标签追加“（已归档）” |
| 中 | 组织列表 → 新建组织 | 已有组织时点“新建组织”打开的全屏引导向导没有关闭按钮，Esc 也不关闭（Radix 只在 DialogContent 内处理 Esc），只能刷新或后退离开 | 已修：按需打开的向导显示“取消”按钮并响应 Esc；首次引导路由不变 |
| 中 | 静态资源回源 | 源站不压缩 UI 产物（index-*.js 6.5 MB 原文），Cloudflare 缓存未命中时经隧道首屏 10 s；index.html 为 no-cache | 已修：源站 brotli/gzip（zlib，内存缓存，弱 ETag/304），哈希产物 `public, max-age=31536000, immutable`，index 壳 `no-store` 并压缩；本地实测 index-*.js 6,558,647 → br 1,441,319 / gzip 1,832,111 字节，安全头保持 |
| 低 | 例行任务详情（不存在 id） | 直接显示服务端英文 404 正文 "Routine not found" | 已修：改走 `userErrorMessage` 中文映射 |
| 低 | 设计指南页 `/design-guide` | 开发用页面向 `connection-intents/*/setup-options` 发非 UUID id，服务端 500 | 未修（上游内部页，非生产入口） |
| 低 | 任务详情 | 每次打开请求 `documents/plan` 404（无计划文档为正常情况），服务端记 warn | 未修：前端把 404 视为“无计划”；改服务端语义会影响 iOS 客户端契约，仅建议日志降噪 |
| 信息 | 智能体向导 → 连接模型 | 无提供方凭据时无法完成创建；页面明确提示需连接 Claude 订阅/API Key | 符合预期，不改 |
| 信息 | 新建任务后数分钟内全部变“受阻 · 需要恢复” | 上游 `configuration_incomplete` 恢复策略（无凭据即升级给董事会） | 不改 |

交给设计/文案（PCA）的纯展示问题：404 页英文标题、看板列头英文状态键、项目“Leave”/“Archive 个项目”、目标级别英文、技能工作室“New skill”、实验页与组织设置的英文 aria-label、密钥视图 Folders/Flat、运行筛选“显示 200 条”、连接模型步骤英文、服务端生成的英文恢复/运行事件文案。

## 结构

- `catalogs/ui-usability.structural.json`（order.json 末位，`after` round2 会话补丁）：main.tsx 重试策略、IssueDetail 横幅/卡片门控与轮询、Timeline 计数、WorkTimelineChart 标签、CloudAccessGate 退出登录、RoutineDetail 错误文案、OnboardingWizard 取消/Esc。
- `native/ui-usability.patch.json` + `native/server/services/issue-terminal-cleanup.ts`、`company-deletion-sweep.ts`：companies.ts 删除顺序与清扫、routes/issues.ts 取消时收尾、work-timeline.ts 与 shared 类型 `archived`、app.ts 静态压缩与缓存头（`static-ui-compression.ts` + 上游 vitest `__tests__/static-ui-compression.test.ts` 6 例）。
- `tests/ui-usability.test.mjs`：接线、重试策略执行、各补丁位置/内容、候选树核对。

## 验证

见仓库 `README.md` 1.1.8 条目与本次最终报告：从干净 `.upstream` 执行 `prepare.sh` 与 `check-upstream.sh`、`@paperclipai/server` / `@paperclipai/ui` typecheck、发行层回归、上游相关 vitest；浏览器复验：未登录跳转 0.49 秒、无权限账号退出登录、删除含预算/目标项目的组织返回 `{"ok":true}`、不存在任务页 0.47 秒显示“未找到”、空闲任务页 20 秒 13 个请求、本地两种模式 WebSocket 均连接并在第二标签页 <50 ms 收到评论。
