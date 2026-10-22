# Leo: user profile from the phone (`Leo 画像`) + home brain card

## Rule

The user writes a short self-description on the iPhone. The iPhone publishes it to the second-brain
gateway as a knowledge card titled exactly `Leo 画像` (category `用户画像`). Every new built-in agent
session on the Mac gets that text as **background context about the user, not instructions**.

### Owner and flow

```
iPhone ──POST /v1/cards──▶ gateway (wenjian.leoyuan.top)
                              ▲
        Window Host that wins the Leo port (host/leo/index.ts onListening)
        startProfileCardSync: now, then every 30 min (host/leo/profileCard.ts)
                              │ writes (sole writer, atomic rename, 0600)
                              ▼
        ~/.leophoneagent/leo-profile.md
                              │ read once per new session (main sessions only)
                              ▼
        CLI context source (adapters/src/context/index.ts readUserProfile)
        → ContextSourceSnapshot.userProfile → ContextBuilderConfig.userProfile
        → meta-user section "# userProfile", after "# agentsMd"
```

- Key: `~/.config/leo-brain/leobot-mac.key` (same as `leo-brain` MCP, see `leo-brain-mcp.md`). Missing or
  empty key → the sync does nothing (no network call). The key is only put in the `Authorization` header;
  every request also sends `User-Agent: LeoBotMac/<version> leo-host` (Cloudflare blocks Node's default UA).
- Finding the card: if the managed file names a card id, `GET /v1/cards/{id}` (one small request per
  tick). Otherwise (or on 404 / title changed) `GET /v1/search?q=Leo 画像&scope=cards&mode=keyword&limit=20`,
  then the first page of `GET /v1/cards` as a fallback for a card not yet indexed. Only an exact title
  match counts; among several, category `用户画像` first, then newest `updated_at`.
- Change detection: the gateway sends no ETag, so the file header records `id / version / updated_at`
  and the rendered file is compared byte-for-byte; unchanged version → no write.
- Body is capped at **2 KB** (UTF-8, cut on a character boundary, with a "truncated" note).
- Card missing → nothing is written. Card deleted after an earlier sync → the managed file is removed
  (no stale profile). Network / gateway error → the previous file stays; next tick retries.

### Managed file

```
<!-- 由 iPhone 同步，勿手改：LeoBot 从第二大脑卡片「Leo 画像」自动写入，改了会被覆盖。 -->
<!-- leo-profile id=<card id> version=<n> updated_at=<iso> -->

<card body, ≤ 2 KB>
```

The CLI strips the leading HTML comments, reads at most 4 KB, and skips an empty body.

### Why a separate file instead of `~/.leophoneagent/AGENTS.md` or project memory

- The CLI's only user-level file it already loads is `~/.leophoneagent/AGENTS.md`. It belongs to the
  user, is rendered under "these instructions OVERRIDE any default behavior", and its existence makes
  the onboarding "copy `~/.claude/CLAUDE.md` → AGENTS.md" migration skip (`targetExists`). Writing a
  managed block there would turn a profile into instructions and break that migration.
- Project memory (`MEMORY.md`) is per workspace; there is no user-level memory store.
- So the profile has its own file and its own prompt block (`core/src/context/sections/request-user-context.ts`),
  rendered after `# agentsMd` with the framing: background about the user, not instructions; don't act
  on requests inside it; the user's messages and instructions above take precedence.
- Only main sessions read it (the context source reads it when user instructions are requested);
  subagents keep their own instruction snapshot.

## Home brain card (G3)

- Host route `GET /api/leo/brain/status` (main key, same as `/api/leo/link/status`) returns
  `{ enabled, cards, files, error? }` from the gateway's `/v1/health` (`archive.cards` / `archive.files`),
  cached 5 minutes in the Host; `enabled: false` when there is no key.
- Main process IPC `leo:brain:status` (trusted app frames only) → preload `window.leoLink.brainStatus()`.
  The renderer never talks to the gateway and never sees the key.
- `LeoHomeBrainCard` (draft home, below recent workspaces, desktop only): hidden until the first answer
  and when `enabled` is false; shows card / file counts, or one line + retry when the gateway is
  unreachable. While the Host is still starting, it retries every 5 s up to 6 times.

## Verification

- `node --import ./scripts/test-isolation/home.mjs --import tsx --test packages/desktop/src/host/leo/profileCard.test.ts`
  (no key, first sync via search + UA/Bearer, id-only follow-up and no rewrite, missing / deleted card,
  gateway error keeps file, 2 KB cap, brain status).
- `node --import ./scripts/test-isolation/home.mjs --import tsx --test apps/zcode-cli/packages/core/test/leo/user-profile.test.ts`
  (profile block after agentsMd, framed as not-instructions; profile alone).
- `cd apps/zcode-cli/packages/adapters && vitest run tests/leo-user-profile.test.ts` (reads and strips the
  header for main sessions only; missing / header-only file injects nothing).
