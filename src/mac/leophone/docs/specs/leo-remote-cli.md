# iPhone 经 Leo Link 使用远程 Mac 上的 CLI

## 规则

- 手机能用的 harness 只由 Mac 的 `GET /v1/capabilities` 决定：`zcode`（LeoBot）+ 全部 ACP 外部 agent
  （`claude` / `codex` / `gemini` / `opencode` / `grok`），不可用的也列出。iOS 不按已知 key 过滤。
- 每个 harness 条目：`key`、`name`、`runtime`（`zcode` | `acp`）、`available`；ACP 另带 `cli_path`、
  `version`（`<cli> --version` 第一行，3s 超时、按文件 mtime 缓存）、`login_command`，不可用时 `unavailable_reason`。
- 旧 leoagent（Python）harness 转发保持默认关闭（WP-23），grok 改走 ACP：`grok agent stdio`。
- CLI 探测与启动共用一条搜索路径（`packages/shared/src/acp-detect.ts` 的 `acpSearchPath`）：
  进程 PATH → 登录 shell 的 PATH（`$SHELL -lic`，3s 超时，进程内缓存一次）→ `~/.local/bin`、`~/.grok/bin`、
  `~/.bun/bin`、`~/.local/npm-global/bin`、`~/.npm-global/bin`、`~/.opencode/bin`、`/opt/homebrew/bin`、
  `/usr/local/bin`、`~/.nvm/versions/node/*/bin`（新版本在前）。启动 agent 时整串写进子进程 PATH。
- LeoBot（`zcode`）任务永远不默认落到 provider `acp`：
  - 新草稿的初始推荐（`resolveInitialModelSelection`）跳过 `acp`，用户默认若是 `acp` 也不采用；
  - `bridge.create`（含 `ready` 检查点重建 draft）显式传入 `resolveLeoBotModelSelection` 的结果；
  - 一个非 acp 模型都没有：`409`「这台 Mac 上 LeoBot 还没配置模型：在 Mac 的 设置 → AI 服务商 添加，或在 iPhone 上用『全部发送到 Mac』」，
    capabilities 里 `zcode.available=false` 并带同一原因。
- 外部 agent 回合失败（未登录、命令找不到、进程退出、其他）时，`run.failed.error` 是一行可读文本：
  「<agent> … ：<在这台 Mac 上怎么修>。agent 最后输出：<stderr 最后 3 行，已脱敏>」，≤480 字。

- 中继入口：Mac 仍只用 `~/.leoagent/relay.json` 的 `url` 连中继；`phone_urls`（可选，https 数组）是同一中继的其他公网入口，
  与主入口一起出现在设备描述符的 `endpoints`（id `relay`、`relay-2`…），手机按速度选。
- Claude Code 长期令牌：`<ZCODE_HOME 或 ~/.leophoneagent>/acp/claude-oauth-token`（一行，0600）。存在即作为
  `CLAUDE_CODE_OAUTH_TOKEN` 传给 claude；启动外部 agent 前去掉宿主的 `CLAUDECODE`、`CLAUDE_CODE_ENTRYPOINT`、
  `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`、`CLAUDE_CODE_SESSION_ID` 等变量。设置页只显示有无，可粘贴 / 移除。
- 系统代理：外部 agent 子进程与内核 CLI 在 env 里没有 `HTTP(S)_PROXY`/`ALL_PROXY` 时，按 `scutil --proxy`（30s 缓存）
  注入 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`（SOCKS 用 `socks5://`）与 `NO_PROXY`；用户 env 已设置时不覆盖。
  设置页「外部 agent 使用系统代理」默认开（`<数据根>/acp/settings.json` 的 `systemProxy`）。

## 验收

- 只装了 grok 的 Mac：capabilities 有 `grok`（available、cli_path、version），手机开 grok 会话走 `acp/grok`。
- 没配个人供应商的 Mac：手机开 LeoBot 任务得到 409 + 上述提示，不会变成 Claude Code 任务。
- Claude Code 未登录：手机看到「Claude Code 在这台 Mac 上未登录或读不到登录态：在这台 Mac 的终端运行 claude 并 /login…」。
- `node scripts/leo-acp-smoke.mjs <agent>`：直接起 agent、握手、开会话、发「只回复OK」，退出码 0/1/2 = 正常/失败/没装。
