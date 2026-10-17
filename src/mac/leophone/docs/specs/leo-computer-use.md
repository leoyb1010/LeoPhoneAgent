# Leo computer use via Peekaboo (WP-22a, macOS)

## Rule

- LeoBot bundles the Peekaboo CLI (openclaw/Peekaboo, MIT). `scripts/leo-fetch-peekaboo.mjs`
  pins the release (4.9.4, universal tarball sha256 plus per-file sha256 of `peekaboo` and
  `libswiftCompatibilitySpan.dylib`), refuses anything that does not match, and copies the files
  and the license to `packages/desktop/leo/bin/` (git-ignored). It runs first in `leo:bundle:mac`
  (after the release-notes gate) and is a no-op when the files are already in place.
- electron-builder ships `leo/bin` to `Contents/Resources/leo/bin` on macOS. The folder is not in
  `signIgnore`, so both Mach-O files are re-signed with LeoBot's Developer ID, hardened runtime and
  `entitlements.mac.inherit.plist` (verified: an ad-hoc re-sign with those flags keeps
  `--version`, `permissions status` and `see` working; the dylib loads from `@loader_path`).
- The Host registers MCP `leo-screen` = `{ command: <bin>/peekaboo, args: ["mcp"] }` through the
  MCP sync service (user scope `~/.leophoneagent/cli/config.json`, same as the settings form). An
  existing entry with the same path is left alone; a moved path only updates command/args and keeps
  a user's "disabled" choice. Missing binary → skip with a warning.
- Settings → 我的设备 → 电脑操作 (macOS only) runs `peekaboo permissions status --json` and shows
  Screen Recording / Accessibility / Event Synthesizing with a button that opens the matching
  Privacy pane. Re-checked on window focus. macOS 27 cannot read TCC.db, so this command is the only
  source.

## Verification

- `node --import tsx --test packages/desktop/src/host/leo/registerPeekabooMcp.test.ts
  packages/desktop/src/main/leo/computerUseCore.test.ts`
- `pnpm leo:fetch-peekaboo` twice (download, then hash-only); a copy of the script with a wrong
  hash fails before touching `leo/bin`.
