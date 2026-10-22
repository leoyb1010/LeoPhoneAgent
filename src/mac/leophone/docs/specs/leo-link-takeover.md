# Leo Link：接管 Mac 终端里的 Claude Code / Codex 会话

场景：在 Mac 终端里用 `claude`、或在 Codex（桌面版 / 终端 `codex`）里干到一半出门，iPhone 上看到这个会话、点进去看到历史、接着发消息继续干。
实现：`packages/desktop/src/host/leo/link/externalSessions.ts`（Claude 扫描 / 历史 / ACP 映射）、`codexSessions.ts`（Codex 扫描 / 历史 / 写锁）、
`externalSources.ts`（按 agent 分流）、`bridge.ts`（路由）。
字段蛇形命名，和其它 `/harness` 路由同风格、同鉴权（中继 / 直连已配对设备）。

## 规则

- 只读 `~/.claude/projects/*/<uuid>.jsonl`（`CLAUDE_CONFIG_DIR` 优先）：按修改时间取最近的，每个只读头 256KB + 尾 64KB，坏行跳过。
  cwd 取 JSONL 里的 `cwd` 字段（目录名是编码过的，不反解）。首条记录 `entrypoint` 以 `sdk-` 开头的（LeoBot 自己的 ACP、`claude -p`）不列、不能接管。
- 标题：Claude Code 自己起的 `custom-title`（最新一条）→ 第一条用户消息（跳过 meta、斜杠命令包装、命令输出、`<system-reminder>`）→ `last-prompt`；前 60 字。
- `running`：最近 60 秒内文件有写入。接管时 `running` 只提示（响应 `warning:"terminal_running"` + 事件流一条说明），不阻止。
- 接管 = 新建一个 `claude`（ACP，`acp/claude-code`）LeoBot 任务，cwd 用会话自己的；在 CLI 的 `<ZCODE_HOME>/cli/acp-sessions.json`
  预置「任务 id → Claude 会话 id」。第一轮 CLI 拉起 claude-agent-acp 时按它 `session/load`（0.93.0 声明 `loadSession: true`；
  ACP 会话 id 就是 JSONL 文件名），之后的消息在原 Claude 会话上续。load 时 agent 回放的历史在开轮时丢弃，不会重复。
- 历史由桌面端直接读 JSONL 尾部（≤2MB、≤600 条）翻成 v0.4 事件写进该任务的日志：
  `session.created → session.note → (user.message → message.delta / reasoning.available / tool.started / tool.completed → run.completed)*`。
  手机按 seq 收到，和普通任务一样续传。子 agent（sidechain）不回放。
- load 失败时 CLI 会新开一个 ACP 会话（上下文丢失）。接管来的任务在回放之后第一次有产出（正文 / 思考 / 工具 / 完成）时，
  桌面端核对一次映射：CLI 写回的 ACP 会话 id 不再是终端那个 → 事件流发 `{"event":"session.note","kind":"resume_failed","text":…}`，
  会话摘要（与任务表）带 `"resume_failed":true`。普通任务不核对。
- 同一个外部会话只接管一次：任务表记 `external_session_id`（重启后仍认得），再接管回同一个任务（`reused:true`）；并发两次只建一个。

## Codex（`agent:"codex"`）

- 数据目录：`CODEX_HOME`，否则（`LEO_ACP_AGENT_HOME` 或）主目录下的 `.codex`。Codex 桌面版与终端 `codex` 共用这一份。
- 只读 `sessions/YYYY/MM/DD/rollout-<时间>-<线程 id>[_<分段 id>].jsonl`：从最新的日期目录往回最多看 300 个文件，按线程 id 归并
  （同一线程可能分好几段，按文件名即时间排序；修改时间取最新一段），按修改时间取最近 20 个。首段读头 256KB（`session_meta`：cwd、source、
  originator、thread_source），最新一段读尾 64KB；解析结果按「文件 + 修改时间 + 大小」缓存。
- 只列交互式会话：`source` 为 `vscode`（桌面版）/ `cli` / 缺省；`codex exec`、子 agent（`thread_source:"subagent"`）、LeoBot 自己经
  codex-acp 开的（`originator` 以 LeoBot / leoagent 开头）不列、不能接管。
- 标题：`session_index.jsonl` 里 Codex 起的 `thread_name`（同一 id 取最后一条）→ 第一条用户消息（跳过 `<…>` 上下文块与
  `# AGENTS.md instructions`；附件清单只取 `## My request…` 之后）→ 最近一条用户消息；前 60 字。
- `busy`（仅 Codex）：最新一段尾部最后一个轮次边界是 `task_started`（之后没有 `task_complete` / `turn_aborted`；尾部 64KB 里一个边界都没有也算），
  且 15 分钟内有写入。`running`：`thread-writer-locks/<id>.lock` 存在（Codex 打开着这个线程）或 `busy` 或 60 秒内有写入。
- 接管 = 新建一个 `codex`（ACP，`acp/codex`）任务，映射写 `{agentId:"codex", acpSessionId:<线程 id>}`；codex-acp（2.2.x 声明 `loadSession`）
  按线程 id `thread/resume`。Codex 打开着线程时持有写锁，另一个进程拿不到锁就续不上（CLI 会悄悄新开对话）：所以锁文件在、且 `lsof` 看到
  有进程开着它时直接 409「先在 Mac 上退出 Codex」；锁文件是崩溃残留（没人开着）照常接管。
- 历史：各分段从新往旧凑够 2MB，`response_item` 翻成同一套事件（用户消息 → `user.message`；`output_text` → `message.delta`；
  `reasoning.summary` → `reasoning.available`；`function_call` / `custom_tool_call` / `local_shell_call` → `tool.started`，对应 `*_output` → `tool.completed`），
  `task_complete` / `turn_aborted` 收轮。加密的推理内容不回放。

## 接口

- `GET /harness/external-sessions` →
  `{"sessions":[{"id":"<uuid>","agent":"claude"|"codex","cwd":"/Users/me/app","title":"把登录页按钮改蓝","updated_at":"2026-10-20T03:30:00.000Z","running":true,"busy"?:true,"leobot_session_id":"sess_…"?}]}`
  （外层包一层 `sessions`，与 `/harness/sessions` 一致；手机端的 JSON 帮手只收对象。旧 Mac 404 → 手机隐藏入口。Claude 与 Codex 合在一起按 `updated_at` 从新到旧。）
- `POST /harness/sessions` `{"resume_external":{"agent":"claude","session_id":"<uuid>"},"mode"?:…,"prompt"?:…}` →
  `202 {"session_id":"sess_…","harness":"claude","status":"idle","full_auto":false,"mode":"build","name":"Claude Code","cwd":…,"title":…,"seq":12,"external_session_id":"<uuid>","warning"?:"terminal_running","reused"?:true}`
  - `agent` 不是 `claude` / `codex` → 501；`session_id` 不是 uuid → 400；找不到（或是 SDK / exec / 子 agent 会话）→ 404；本机对应 agent 用不了 → 409；
    Codex 正开着这个线程（写锁有人持有）→ 409；写映射 / 开日志失败 → 502。Codex 接管的 `harness` 为 `codex`、`name` 为 `Codex`。
- `capabilities.features.external_sessions: true`；`external_sessions_codex: true` = 列表里也有 Codex 会话。

## 工具事件补全

`tool.started` 带完整 `input`（JSON ≤16KB；超出时 `input` 为截断的 JSON 文本并带 `input_truncated:true`）；
`tool.completed` 带 `output`（文本 ≤32KB；超出保留头 4KB + 尾 28KB，带 `output_truncated:true`）。`preview` 照旧。

## 验收

`node --import ./scripts/test-isolation/home.mjs --import tsx --test packages/desktop/src/host/leo/link/externalSessions.test.ts packages/desktop/src/host/leo/link/codexSessions.test.ts packages/desktop/src/host/leo/link/eventMap.test.ts`：
临时 HOME 造 JSONL → 列表（排序、标题、SDK / 坏文件排除、running）、历史翻译、uuid / agent 校验、映射预置（不覆盖别的任务）、事件流回放、
重复 / 并发接管同一任务、重启后仍认得。
Codex：临时 CODEX_HOME 造分段 rollout → 列表（分段归并、索引名、exec / 子 agent / LeoBot 排除、busy / 写锁）、历史翻译、
写锁被持有时 409、残留锁照常接管、映射 `agentId:"codex"`、回放与重复接管。
