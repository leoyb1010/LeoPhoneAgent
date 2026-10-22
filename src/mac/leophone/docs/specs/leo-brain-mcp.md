# Leo: second-brain MCP (`leo-brain`)

## Rule

Every LeoBot Mac agent session gets the user's second-brain tools through a user-level MCP
server named `leo-brain`, registered the same way as `leo-treasury`.

- Owner of the registration: the Window Host that wins the Leo port (`host/leo/index.ts`
  `onListening`), via `registerBrainMcpServer` (`host/leo/registerBrainMcp.ts`) → MCP sync service
  user scope (`~/.leophoneagent/cli/config.json`, `mcp.servers`). Visible and disableable in
  Settings; a user's `enabled: false` and extra env entries survive re-registration.
- Registered only when the key file `~/.config/leo-brain/leobot-mac.key` (0600, provisioned per Mac)
  exists. No key → info log, no entry.
- Entry: `command = process.execPath`, `args = [<Resources>/leo/brain-mcp.mjs]`,
  `env = { ELECTRON_RUN_AS_NODE: "1", LEO_BRAIN_KEY_FILE: <path> }`. The key itself is never written
  to the config (every agent can read it) nor logged.
- Server (`packages/desktop/leo/brain-mcp.mjs`, packaged via `extraResources`): stdio JSON-RPC,
  no dependencies, Node port of the gateway's reference `leo_brain_mcp.py`. Tools: `brain_brief`,
  `brain_search`, `brain_read`, `brain_ask`, `brain_save_card`, `brain_upload`, `brain_link`,
  `brain_media_search`, `brain_media_get`. Usage guidance travels in the `initialize`
  `instructions` field.
- Gateway: `LEO_BRAIN_URL` (default `https://wenjian.leoyuan.top`, Cloudflare tunnel). Requests send
  `User-Agent: LeoBotMac/<app version> leo-brain-mcp/<version>`; timeouts 40 s, 300 s for upload.
  HTTP errors become `isError` tool results with the gateway message plus a hint for 401/403/404/409/429.

## Verification

`node --import tsx --test packages/desktop/src/host/leo/registerBrainMcp.test.ts`
(registered / unchanged / no key / keeps disabled), plus a live JSON-RPC run of the script
(`initialize`, `tools/list`, `brain_brief`, `brain_search`, `brain_read`).
