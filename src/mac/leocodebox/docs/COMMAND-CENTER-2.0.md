# leocodebox 2.0「指挥部」——已落地能力(后端 + API)

本轮实现了 2.0 升级计划 1–5 级的**服务端能力 + REST API + 测试**(未含 UI 界面与 gemini/pi/qwen 的 L3 运行时——见文末「后续」)。所有能力已随本机服务在 `127.0.0.1:38473` 暴露,可直接经 API 驱动;各级均带自动化测试,门禁全绿。

数据全部落本机 SQLite / `~/.leocodebox`,无新增网络面。

---

## L1 · 模型弹药库(接入已有用量账本)

`server/shared/model-arsenal.ts`:40+ 模型的 context window / 输出上限 / 输入输出单价 / 视觉·推理·工具能力 / wire 协议,离线嵌入。

- **用量成本**(`estimateUsageCostUsd`):用户价目覆盖 > 弹药库精确单价 > 旧子串表 > 0(未知模型只显 token,不编造成本)。
- **上下文窗口**(`getModelContextWindow`):弹药库优先,回落旧默认表。
- `GET /api/usage/arsenal` → `{ models: [...] }`(录入 UI 数据源)。
- 既有 `GET /api/usage/summary`、`/api/usage/prices` 不变,现由弹药库增强成本。

## L2 · 路由控制面(Leoapi 2.0)

场景槽位把任务形态路由到不同 Leoapi 节点,**零常驻代理**——决策后经既有 per-session env 接管注入(`applyActiveSwitchEnv(env, target, slot)`)。未绑定槽 = 旧单活跃行为(完全向后兼容)。

- 内置槽:`default / background / longContext / think`(也可自定义)。
- `GET /api/leocodebox/routing/:target` → 槽绑定 + 内置槽 + 该 target 的节点。
- `PUT /api/leocodebox/routing/:target/:slot` `{ providerId, model? }` → 绑定。
- `DELETE /api/leocodebox/routing/:target/:slot` → 解绑。
- 起会话时 `resolveSlotForSession`(显式 > 后台 > 长上下文 > default)自动选槽;runtime 读 `options.routingSlot` 注入。

## L3 · 舰队(worktree 并行)

每个并行任务跑在独立 git worktree(`<project>/.leocodebox/worktrees/<slug>`,分支 `lcb/<slug>`),会话经 `sessions.worktree_id` 绑定后以 worktree 目录为 cwd,互不踩脚。

- `GET /api/leocodebox/worktrees?projectPath=…` → 列表 + 孤儿。
- `POST /api/leocodebox/worktrees` `{ projectPath, slug }` → 创建。
- `GET /api/leocodebox/worktrees/:id/status` → dirty / ahead / behind。
- `GET /api/leocodebox/worktrees/:id/preview-merge` → 无副作用冲突预检(`git merge-tree --write-tree`)。
- `POST /api/leocodebox/worktrees/:id/merge` `{ squash? }` → 预检过才真合。
- `DELETE /api/leocodebox/worktrees/:id?force=true` → 脏树无 force 拒绝。

## L4 · 看板中枢(任务卡)

任务卡 = 目标 + 指派档案(→ provider + 槽)+ worktree + 会话,状态机驱动舰队。`backlog → running → review → done | discarded`(含重置/重试,非法转移拒绝)。

- `GET /api/leocodebox/missions?projectPath=…`
- `POST /api/leocodebox/missions` `{ projectPath, title, goal, profileId?, slot? }`
- `POST /api/leocodebox/missions/:id/start` → 起 worktree + 绑定会话(按档案定 provider,未固定槽则自动选槽)。
- `POST …/:id/retry` → review→running,复用 worktree 起新会话。
- `POST …/:id/transition` `{ to }` · `POST …/:id/complete` `{ costUsd? }`(冻结成本)· `POST …/:id/discard?force=` · `DELETE …/:id`

## L5 · 登录态快照

对 claude(`~/.claude/.credentials.json`)/ codex(`~/.codex/auth.json`)的 CLI 官方账号登录态做**命名快照**并一键切换,与 Leoapi 互补(Leoapi 换 key/端点,快照换 CLI 自身 OAuth)。apply 先自动备份当前登录再覆盖,全部 0600。

- `GET /api/leocodebox/login-snapshots/:target`
- `POST /api/leocodebox/login-snapshots/:target` `{ name }` → 抓当前登录。
- `POST …/:target/:name/apply` → 切换(先备份后覆盖)。
- `DELETE …/:target/:name`

---

## 验证

门禁全绿:客户端/服务端 typecheck、ESLint 0 警告、生产构建;测试 **390**(desktop 27 + client 71 + server 292,含本轮新增 **21** 条覆盖 L1–L5)。L3/L4 用真实临时 git 仓库端到端验证 worktree 生命周期与卡片状态机。

## 后续(本轮未含,诚实标注)

- **UI 界面**:用量页 / 路由标签 / 看板顶层视图等前端表面——本轮为后端能力 + API,前端接线为独立工作。
- **gemini / pi / qwen 的 L3 运行时**:需按 grok 的方式先在隔离环境抓取真实 CLI 事件 schema 再实现 normalizer,不能凭空臆造;本轮已把 gemini 等纳入弹药库(模型/价格/context)与状态检测,运行时接入留作后续。
