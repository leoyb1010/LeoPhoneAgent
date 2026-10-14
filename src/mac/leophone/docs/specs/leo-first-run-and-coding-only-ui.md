# Leo first run and coding-only UI

## Rule

LeoBot Mac is a single-user coding app. There is no first-run "what do you do"
selection, no coding/office interface mode, and no whiteboard or treemapping
side-pane tool.

- First launch on a fresh data dir: startup loading, then the normal workspace
  or home screen. The only screen that can come before it is `WelcomeScreen`,
  and only when no model provider is usable (startup provider check, expired
  session, or an explicit login request). It is a static card (subscription
  login / API key), not an onboarding flow.
- Everything renders as the former "coding" mode: terminal, Git review, command
  details, file change summaries and the command-center terminal/review entries
  are always available.
- `OnboardingDialog` is kept only as the migration wizard (Claude Code sessions,
  Skills, MCP, commands, CLAUDE.md → AGENTS.md). It opens from Settings → General
  → 迁移向导; it has no welcome page and does not auto-open on first run
  (first-run discovery is empty and is marked handled).

## Persisted data

Old values are ignored on read and never rewritten or deleted:
`localStorage["zcode-interface-mode"]`, `settings.onboardingOccupation`,
`settings.proactiveSuggestionsEnabled`, the old onboarding record file, shortcut
overrides for `openOnboarding` / `toggleInterfaceMode` (unknown commands are
dropped by the shortcut resolver), composer drafts holding a whiteboard mention
(the mention is dropped), and saved side-pane tabs of type `whiteboard` /
`treemapping` (filtered in `normalizeWorkspaceSidePaneState`).

## Verification

`pnpm typecheck`, `pnpm lint`, `pnpm knip`; `node --import tsx --test` for
`packages/ui/test` and `packages/services/test`.
