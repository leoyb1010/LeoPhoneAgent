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
  `brain_link`, `brain_media_search`, `brain_media_get`. Usage guidance travels in the `initialize`
  `instructions` field. `brain_upload` streams the file (`fs.openAsBlob`), never buffers it in the Host.
- Gateway: `LEO_BRAIN_URL` in the Host's environment (default `https://wenjian.leoyuan.top`, Cloudflare
  tunnel). Requests send `User-Agent: LeoBotMac/<app version> leo-brain-mcp/<version>`; timeouts 40 s,
  300 s for upload. HTTP errors become `isError` tool results with the gateway message plus a hint for
  401/403/404/409/429.
- When an HTTP proxy is configured in Settings, the agent spawn env adds `localhost,127.0.0.1,::1` to
  `NO_PROXY`/`ZCODE_NO_PROXY` (`services/src/runtime-tools/agentProxyEnv.ts`), so the CLI reaches the
  loopback endpoint directly.

## Verification

`node --import tsx --test packages/desktop/src/host/leo/registerBrainMcp.test.ts`
(registered / unchanged / no key / stdio entry migrated, disable kept) and
`packages/desktop/src/host/leo/mcpHttpEndpoint.test.ts` (the CLI's own SDK client in auto version
negotiation connects, lists, calls; key read per request; upload streamed; protocol edges).
