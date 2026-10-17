# Leo: iMCP one-click registration (macOS)

## Rule

Settings → 扩展 → MCP (user scope) shows a "推荐：iMCP" card until a user-level MCP server
named `imcp` exists. iMCP (mattt/iMCP, MIT) is a separate menu bar app that owns the TCC
grants (Calendar, Reminders, Contacts, Messages, Shortcuts); LeoBot never bundles or installs it.

- Detection (Main, read-only): `/Applications/iMCP.app/Contents/MacOS/imcp-server` exists →
  installed. App present without the shim → treated as not installed (upgrade hint).
  Re-checked when the window regains focus.
- Installed: "一键添加" writes `{ command: <shim path> }` under the name `imcp` through the same
  path as the settings "新建" form (user scope `~/.leophoneagent/cli/config.json`, key
  `mcp.servers`; the agent also reads `~/.agents/mcp.json`, which stays untouched).
- Not installed: shows `brew install --cask mattt/tap/iMCP` with a copy button.

## Verification

`node --import tsx --test packages/desktop/src/main/leo/imcp.test.ts` (both branches, other
platforms, and the real write path with a temporary HOME).
