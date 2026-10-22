# Leo: second-brain MCP (`leo-brain`)

## Rule

Every LeoBot Mac agent session gets the user's second-brain tools through a user-level MCP
server named `leo-brain`, registered the same way as `leo-treasury`.

- Owner of the registration: the Window Host that wins the Leo port (`host/leo/index.ts`
  `onListening`), via `registerBrainMcpServer` (`host/leo/registerBrainMcp.ts`) → MCP sync service
  user scope (`~/.leophoneagent/cli/config.json`, `mcp.servers`). Visible and disableable in
  Settings; a user's `enabled: false` survives re-registration.
- Registered only when the key file `~/.config/leo-brain/leobot-mac.key` (0600, provisioned per Mac)
  exists. No key → info log, no entry.
- Entry (since up-d-mac): `{ type: "http", url: "http://127.0.0.1:38473/api/leo/brain/mcp",
  headers: { Authorization: "Bearer <treasury key>" } }`. The endpoint is served by the same Window
  Host that owns the Leo port (`host/leo/httpApi.ts`), so every workspace's CLI shares it instead of
  spawning its own stdio child. Auth is the limited treasury key (`~/.leoagent/treasury.key`), which
  only opens `/api/leo/treasury/*` and `/api/leo/brain/mcp`, never the master key. An old stdio entry
  (`command`/`args` → `brain-mcp.mjs`) is replaced on startup; a user's `enabled: false` is kept.
- The brain key itself is read by the Host from the key file on every request and only goes into the
  gateway's `Authorization` header: never written to the MCP config, never logged, never returned.
- Server (`packages/desktop/src/host/leo/brainTools.ts` behind `mcpHttpEndpoint.ts`): stateless
  streamable-HTTP JSON-RPC (POST → JSON; notifications → 202; GET/DELETE → 405; `server/discover` →
  -32601 so the SDK falls back to `initialize`). Port of the gateway's reference `leo_brain_mcp.py`.
  Tools: `brain_brief`, `brain_search`, `brain_read`, `brain_ask`, `brain_save_card`, `brain_upload`,
  `brain_link`, `brain_media_search`, `brain_media_get`. Tool definitions (names, descriptions incl.
  when to use them, schemas, budgets) live in `brainToolDefs.ts`; descriptions no longer tell the model
  to call `brain_brief` first. `initialize` `instructions` carries the same short usage note (the CLI
  does not put it in the prompt; see Routing below). `brain_upload` streams the file (`fs.openAsBlob`),
  never buffers it in the Host.
- There is one endpoint per Mac, not one stdio child per workspace. The per-workspace context the
  tools need comes from the CLI's `tools/call` `params._meta` (`mcpRequestMeta` in
  `apps/zcode-cli/packages/adapters/src/mcp/index.ts`: `workspace_path`, also nested under
  `com.zcode/request-context`), passed through `McpHttpServer.callTool(name, args, meta)`.
- Timeouts: every tool advertises its total budget in `tools/list` `_meta.timeoutMs`, which the CLI
  uses as that tool's wait limit (`adapters/src/mcp/descriptor.ts`; without it the CLI waits only 30 s):
  `brain_media_get` / `brain_ask` 60 s, `brain_upload` 330 s, the rest 45 s. The Host side stays below
  that: each call gets a deadline of budget − 5 s, and every gateway request is capped at
  `min(per-request timeout, time left)` (default 40 s; upload 325 s; `brain_ask` `wait_seconds` clamped to
  0–45 with a request timeout of wait + 10 s). So the model sees a concrete gateway timeout / HTTP error
  instead of the CLI's generic timeout.
- `brain_upload` path: `~` is expanded; a relative path is resolved against the workspace from
  `params._meta` (the Host's own cwd is `/`). With no absolute workspace in `_meta`, a relative path is
  rejected (`需要绝对路径`).
- `brain_save_card` rejects the title `Leo 画像` (trimmed) before calling the gateway: that title is
  reserved for the iPhone-maintained profile card (`leo-profile-card.md`).
- Gateway: `LEO_BRAIN_URL` in the Host's environment (default `https://wenjian.leoyuan.top`, Cloudflare
  tunnel). Requests send `User-Agent: LeoBotMac/<app version> leo-brain-mcp/<version>`. HTTP errors
  become `isError` tool results with the gateway message plus a hint for 401/403/404/409/429.
- When an HTTP proxy is configured in Settings, the agent spawn env adds `localhost,127.0.0.1,::1` to
  `NO_PROXY`/`ZCODE_NO_PROXY` (`services/src/runtime-tools/agentProxyEnv.ts`), so the CLI reaches the
  loopback endpoint directly.

### Routing (session guidance)

MCP server `instructions` don't reach the prompt and tool descriptions alone didn't get the model to
look things up, so `buildSessionGuidanceSection` (`apps/zcode-cli/packages/core/src/context/dynamic-sections.ts`)
adds one line under `# Session-specific guidance` when `mcp__leo-brain__brain_search` is among the
session's tools: for questions about Leo, his projects, earlier work or decisions, people in his life,
or 我的/之前/上次/记得/笔记/资料/大脑, call `brain_search` first (no `brain_brief`), `brain_read` for
details, cite the title. If the tools are missing or fail, tell the user; never read
`~/.config/leo-brain/*`, `~/.leoagent/key` or `~/.leoagent/treasury.key`, never call the endpoint by hand.

## Verification

`node --import tsx --test packages/desktop/src/host/leo/registerBrainMcp.test.ts`
(registered / unchanged / no key / stdio entry migrated, disable kept) and
`packages/desktop/src/host/leo/mcpHttpEndpoint.test.ts` (the CLI's own SDK client in auto version
negotiation connects, lists, calls; key read per request; upload streamed; every tool's
`_meta.timeoutMs`; `brain_upload` relative path rejected without a workspace and resolved from flat or
nested `_meta.workspace_path`; `Leo 画像` title refused; protocol edges) and
`node --import tsx --test apps/zcode-cli/packages/core/test/leo/session-guidance.test.ts` (brain routing
line only when `brain_search` is registered).
