# Browser Control Runtime — Vendoring Build Plan

> **历史文档(仅供溯源)。** vendoring 已交付,日常维护看 `MAINTAINING.md`,现状看 `STATUS.md`。
> 本文保留最初的提取规划,用于理解 `_generated/` 的来历与 `sync.mjs` 的设计意图。

Authoritative plan for the full extraction (durable across sessions). Generated
from dependency-closure analysis against upstream commit
`b972feb3f791ed38dafc27c1961dc87f2e30b210` (extensions/browser) and the published
`@openclaw/fs-safe@0.4.0` npm package.

Product-facing neutrality: the upstream project name appears ONLY in this
`upstream/` metadata directory and the sync script. Generated code keeps
load-bearing internal identifiers but is never surfaced to users; package name,
MCP tool name, and settings ids stay neutral (`browser` / `cindy_browser`).

## Layout

```
packages/browser-control-runtime/
  src/
    _generated/
      extension/      <- 133 browser-core files (extensions/browser/src/**), verbatim
      packages/       <- vendored upstream workspace pkgs (source from tarball)
        net-policy/
        normalization-core/
      vendor/
        fs-safe/      <- @openclaw/fs-safe 0.4.0 dist (89 files, zero-dep ESM)
    shim/             <- hand-written replacements for plugin-sdk subpaths
    runtime.ts        <- createBrowserControlRuntime(): BrowserControlRuntime
    host.ts           <- host injection contract (config/logger/security/media)
```

All of `_generated/` is GENERATED — do not edit. Re-run `pnpm sync:browser-runtime`.

## Source buckets (measured, not guessed)

| Bucket | Count | Source | How |
|---|---|---|---|
| browser core | 133 | extensions/browser/src (GitHub tarball @ commit) | vendor verbatim, rewrite plugin-sdk imports → shim |
| net-policy | 1+ | packages/net-policy/src (tarball, unpublished) | vendor source |
| normalization-core | 4 | packages/normalization-core/src (tarball, unpublished) | vendor source |
| fs-safe | 89 | @openclaw/fs-safe@0.4.0 npm dist (NOT in tarball) | vendor dist, version-pinned in lock |
| SSRF/security leaves | ~14 | src/infra/net/**, src/security/** (tarball) | vendor source (faithful — security teeth) |

External npm actually required by the security closure: `ipaddr.js`, `undici`,
`zod` (all already present in the monorepo). `fs-safe` is zero-dependency.

## Shim surface (hand-written, src/shim/*)

Leaf utility subpaths — port faithfully from tarball source:
- `string-coerce-runtime`, `number-runtime`, `text-utility-runtime` → re-export vendored normalization-core
- `browser-config` (parseBrowserHttpUrl/redactCdpUrl/movePathToTrash)
- `security-runtime` → re-export vendored fs-safe + SSRF leaves + secret-equal + external-content
- `ssrf-runtime` / `ssrf-runtime-internal` → re-export vendored SSRF leaves
- `temp-path`, `json-store`, `process-runtime`, `error-runtime`, `routing`

Host-coupled subpaths — minimal correct impl / host injection:
- `logging-core` (createSubsystemLogger/redactSensitiveText/redactToolPayloadText) → console logger + faithful redact subset; NOT the 54-config-type tslog graph
- `config-contracts` / `runtime-config-snapshot` / `config-mutation` / `plugin-config-runtime` / `core` → in-memory config provider seeded from host (browser profiles, ssrf policy, ports)
- `media-runtime` / `media-mime` / `media-understanding-runtime` → host-injected image resize + describeImageFile callback (Cindy image-understanding infra); safe default = clear error
- `gateway-runtime` → only isLoopbackHost / resolveGatewayAuth / ensureGatewayStartupAuth needed on dispatcher path; loopback-only, host-token
- `cli-runtime` / `channel-actions` / `agent-harness-runtime` / `plugin-entry` / `plugin-runtime` / `setup-tools` / `runtime-env` → thin stubs (dispatcher path only touches formatCliCommand, jsonResult, image helpers)

## Entry point

`src/_generated/extension/src/browser/local-dispatch.runtime.ts`
→ `dispatchBrowserControlRequest(req)` drives the in-process route dispatcher.
`runtime.ts` wraps it behind the `BrowserControlRuntime.call(request)` contract.

## Why the SDK itself is not vendored

Following plugin-sdk barrels transitively reaches ~3957 monolith files. The
barrels fan into the entire app (agents, channels, gateway). We vendor only the
133-file browser core + bounded security leaves and shim the rest.
