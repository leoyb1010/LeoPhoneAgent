# Domain A: agent capability, system control, and result presentation

> **Correction (2026-09-25, after review):** the active Mac app is `src/mac/leophone` (ZCode kernel), which already renders with Streamdown, Shiki and KaTeX. Notes below that call the Mac app "CloudCLI-based" describe the legacy `src/mac/leocodebox` (2.2.x, fallback only).

Research for the LeoPhoneAgent upgrade plan. Snapshot date: **2026-09-25**.

**Method.** Stars, license, and last push come from the GitHub API (`gh api repos/...`) on the snapshot date. "Last activity" means the last push. The findings come from READMEs, repository docs and, where noted, source files. Docs sites were read with WebFetch and are marked "(docs)". Anything I did not see myself is marked *unverified*. No repository was modified.

---

## 0. LeoPhoneAgent facts checked (read-only), so the lessons fit what already exists

- **iOS Live Activities.** Local runs call `Activity.request(..., pushType: nil)` with `ActivityContent(state:, staleDate: nil)` (`src/ios/Agent/Background/AgentLiveActivityManager.swift`). Relay missions already register a device token and a push-to-start token (`src/ios/Agent/Gateway/PushRegistrar.swift`). `ContentState` (`src/ios/Shared/AgentActivityAttributes.swift`) already merges sessions (`sessions`, `activeSessionCount`) but has **no sequence number**.
- **Approval notifications.** The category has two actions: 批准一次 (`.authenticationRequired`) and 拒绝. They are not posted while the app is in the foreground (`HarnessApprovalNotifier.swift`). No `UNTextInputNotificationAction` (quick reply) was found.
- **iOS Markdown.** The app has its own `cmark_gfm` parser (`Agent/Markdown/MinisMarkdownParser.swift`), plus `SelectableMarkdownView`, `PaginatedMarkdownView` and `TextFadeAnimator`. The SPM dependencies already include `swift-crypto`, `citadel` and `swift-nio*`.
- **Android Markdown.** `multiplatform-markdown-renderer` is pinned at **0.33.0**; upstream is at v0.45.0 (2026-08-28). No use of its streaming-state API was found.
- **Mac app.** `src/mac/leocodebox/NOTICE` says "This distribution is based on CloudCLI UI". It uses `react-markdown`, `katex` and `@xterm/xterm`.
- **Relay.** `src/mac/leoagent/*.py` authenticates with HMAC tokens. A grep found no payload encryption.

---

## 1. Kept projects

| # | Project | URL | License | Stars | Last push | Why it matters |
|---|---|---|---|---|---|---|
| **A. Remote/mobile clients for coding agents** |||||||
| A1 | Happy (Happy Coder) | https://github.com/slopus/happy | MIT | 23.9k | 2026-09-22 | The most complete open mobile client for Claude Code and Codex: E2E relay, approvals and voice, with written performance budgets |
| A2 | Paseo | https://github.com/getpaseo/paseo | Apache-2.0 (LICENSE; API says NOASSERTION) | 18.5k | 2026-09-25 | Same shape as LeoPhoneAgent remote control (daemon + E2E relay + iOS/Android/desktop). Best docs on stream pacing and push routing |
| A3 | Mimi Remote | https://github.com/gaixianggeng/mimi-remote | GPL-3.0 + App Store exception | 102 | 2026-09-25 | Native SwiftUI iPhone/iPad client built on the Codex app-server. Written iPhone-vs-iPad design principles |
| A4 | CodeIsland (+ Code Island Buddy) | https://github.com/wxtsky/CodeIsland | MIT | 2.4k | 2026-09-24 | Status and approvals for 30+ CLIs through hooks. iPhone Live Activity and Watch companion with no backend |
| A5 | OpenCode + OpenCode iOS Client | https://github.com/anomalyco/opencode · https://github.com/grapeot/opencode_ios_client | MIT · MIT | 209.9k · 254 | 2026-09-25 · 2026-09-22 | Client/server agent with OpenAPI + SSE and pattern-based permissions. Native three-column iPad client |
| A6 | CloudCLI (Claude Code UI) | https://github.com/siteboon/claudecodeui | AGPL-3.0 | 13.8k | 2026-09-24 | **Upstream of the LeoPhoneAgent Mac app** |
| A7 | Nimbalyst (ex-Crystal) | https://github.com/nimbalyst/nimbalyst | MIT | 1.8k | 2026-09-24 | Desktop agent workspace with an iOS companion: swipe through diffs, queue the next task |
| A8 | Agent Client Protocol (+ claude-agent-acp) | https://github.com/agentclientprotocol/agent-client-protocol · https://github.com/agentclientprotocol/claude-agent-acp | Apache-2.0 | 4.3k · 2.6k | 2026-09-25 | One tool-call and permission model across many CLIs |
| A9 | Codex app-server | https://github.com/openai/codex (`codex-rs/app-server`) | Apache-2.0 | 126.4k | 2026-09-25 | Official structured JSON-RPC runtime with typed approval decisions |
| A10 | VibeTunnel | https://github.com/amantus-ai/vibetunnel | MIT | 4.7k | 2026-08-05 | Terminal mirroring as a fallback, plus activity indicators |
| A11 | Agent Watch (claude-watch) | https://github.com/shobhit99/claude-watch | **none** (all rights reserved) | 609 | 2026-04-24 | Watch-first approval UX reference. Ideas only; the code has no license |
| **B. General agent apps** |||||||
| B1 | OpenMinis (upstream) | https://github.com/OpenMinis/OpenMinis | GPL-3.0 | 4.7k | 2026-09-01 | The upstream fork base: iOS/Android agent with a sandbox |
| B2 | OpenClaw | https://github.com/openclaw/openclaw | MIT (LICENSE; API says NOASSERTION) | 390.5k | 2026-09-25 | Personal agent with iOS/Android/macOS/Watch nodes, an approval inbox, exec-approval policy and Canvas |
| B3 | Hermes Agent | https://github.com/NousResearch/hermes-agent | MIT | 248.8k | 2026-09-25 | Learning loop: memory nudges, automatic skills, FTS5 recall |
| B4 | goose | https://github.com/aaif-goose/goose (was block/goose) | Apache-2.0 | 54.6k | 2026-09-25 | Four permission modes including Smart Approval. MCP Apps host. Docs say it works best under 25 tools |
| B5 | OpenHands | https://github.com/OpenHands/OpenHands | MIT | 89.1k | 2026-09-25 | Risk-annotated actions plus confirmation policies |
| B6 | LibreChat | https://github.com/LibreChat-AI/LibreChat | MIT | 44.9k | 2026-09-25 | Resumable streams, restrained smooth streaming, artifacts |
| B7 | Open WebUI | https://github.com/open-webui/open-webui | Open WebUI License (custom) | 153.1k | 2026-09-25 | Feature checklist for memory, code execution and voice calls |
| B8 | Cherry Studio | https://github.com/CherryHQ/cherry-studio | AGPL-3.0 | 52.1k | 2026-09-25 | Desktop peer to the Mac app: several models at once, MCP |
| B9 | AnythingLLM (+ Mobile) | https://github.com/Mintplex-Labs/anything-llm · https://github.com/Mintplex-Labs/anythingllm-mobile | MIT · GPL-3.0 | 66.4k · 105 | 2026-09-25 · 2026-09-23 | Per-query tool reranking, phone-as-harness, Android selection-toolbar entry |
| B10 | Operit | https://github.com/AAswordman/Operit | LGPL-3.0 | 8.1k | 2026-09-22 | Closest Android peer: PRoot Ubuntu, Accessibility/Shizuku/Root, per-tool "ask" |
| B11 | RikkaHub | https://github.com/rikkahub/rikkahub | AGPL-3.0 | 7.8k | 2026-09-25 | Native Android LLM client with a proot workspace and MCP |
| B12 | FlowDown | https://github.com/Lakr233/FlowDown | AGPL-3.0 | 1.2k | 2026-09-07 | Native iOS/macOS client built for speed. Its chat and Markdown libraries were extracted under MIT |
| B13 | Open Interpreter | https://github.com/openinterpreter/openinterpreter | Apache-2.0 | 68.4k | 2026-09-25 | "Harness emulation" per provider. ACP-compatible |
| **C. System-control agents** |||||||
| C1 | Mobilerun (ex-DroidRun) + Portal | https://github.com/droidrun/mobilerun · https://github.com/droidrun/mobilerun-portal | MIT · custom (API says NOASSERTION) | 9.5k · 381 | 2026-09-25 · 2026-09-16 | Accessibility-service agent with an on-screen element overlay and per-app "app cards" |
| C2 | Open-AutoGLM | https://github.com/zai-org/Open-AutoGLM | Apache-2.0 | 26.3k | 2026-03-06 | `Take_over` action and confirmation for sensitive operations |
| C3 | mobile-mcp | https://github.com/mobile-next/mobile-mcp | Apache-2.0 | 6.9k | 2026-09-23 | Accessibility-first control with a batch-commands tool |
| C4 | Midscene.js | https://github.com/web-infra-dev/midscene | MIT | 15.0k | 2026-09-24 | Vision-first control. Step replay reports |
| C5 | UI-TARS-desktop / Agent TARS | https://github.com/bytedance/UI-TARS-desktop | Apache-2.0 | 39.1k | 2026-09-24 | Hybrid GUI/DOM browser agent. Event stream viewer |
| C6 | PhoneAgent | https://github.com/rounak/PhoneAgent | MIT | 789 | 2026-08-15 | Shows where iOS cross-app control stops (it needs XCTest). Quick-reply notification loop |
| C7 | Peekaboo | https://github.com/openclaw/Peekaboo | MIT | 5.2k | 2026-09-25 | macOS automation that runs in the background by default and asks consent before taking the foreground |
| C8 | iMCP | https://github.com/mattt/iMCP | MIT | 1.7k | 2026-09-24 | Personal-data tools on the Mac, with permission state shown visibly |
| C9 | Stagehand | https://github.com/browserbase/stagehand | MIT | 25.4k | 2026-09-25 | Credentials never reach the model |
| C10 | Playwright MCP | https://github.com/microsoft/playwright-mcp | Apache-2.0 | 37.6k | 2026-09-18 | Accessibility snapshots. Extra capabilities are opt-in |
| C11 | agent-browser | https://github.com/vercel-labs/agent-browser | Apache-2.0 | 43.2k | 2026-09-24 | Token-lean refs and screenshots. Boundaries around untrusted page content |
| **D. Result presentation / generative UI** |||||||
| D1 | MCP Apps (ext-apps) + MCP-UI | https://github.com/modelcontextprotocol/ext-apps · https://github.com/MCP-UI-Org/mcp-ui | MIT→Apache-2.0 (transition) · Apache-2.0 | 2.9k · 5.2k | 2026-09-24 · 2026-09-16 | The standard for tool UIs in sandboxed iframes |
| D2 | A2UI | https://github.com/a2ui-project/a2ui | Apache-2.0 | 16.5k | 2026-09-25 | Declarative UI built from a catalog. Official SwiftUI renderer that includes watchOS |
| D3 | json-render | https://github.com/vercel-labs/json-render | Apache-2.0 | 18.3k | 2026-09-23 | Generative UI limited to a component catalog |
| D4 | AG-UI + CopilotKit | https://github.com/ag-ui-protocol/ag-ui · https://github.com/CopilotKit/CopilotKit | MIT · MIT | 16.0k · 37.5k | 2026-09-25 | Event protocol with JSON Patch state deltas and interrupts |
| D5 | Vercel AI SDK + AI Elements + Streamdown | https://github.com/vercel/ai · https://github.com/vercel/ai-elements · https://github.com/vercel/streamdown | Apache-2.0 (LICENSE files) | 26.9k · 2.5k · 5.6k | 2026-09-25 · 2026-09-01 · 2026-09-21 | Tool-part state machine, a component taxonomy, streaming-safe Markdown |
| D6 | assistant-ui | https://github.com/assistant-ui/assistant-ui | MIT | 12.3k | 2026-09-25 | Chat primitives with inline approvals |
| D7 | OpenAI Apps SDK (examples, apps-sdk-ui, UI guidelines) | https://github.com/openai/openai-apps-sdk-examples · https://github.com/openai/apps-sdk-ui | MIT · MIT | 2.3k · 944 | 2026-04-15 · 2026-05-20 | Rules for inline cards |
| D8 | Textual (successor of swift-markdown-ui) | https://github.com/gonzalezreal/textual · https://github.com/gonzalezreal/swift-markdown-ui | MIT · MIT | 884 · 3.9k | 2026-06-15 · 2025-12-28 | SwiftUI-native text engine. MarkdownUI is in maintenance mode |
| D9 | MarkdownView (Lakr233) + LanguageModelChatUI | https://github.com/Lakr233/MarkdownView · https://github.com/Lakr233/LanguageModelChatUI | MIT · MIT | 154 · 80 | 2026-09-09 · 2026-04-08 | UIKit Markdown built for streaming, including a watchOS renderer |
| D10 | MarkdownView (LiYanan2004) | https://github.com/LiYanan2004/MarkdownView | MIT | 836 | 2026-08-12 | SwiftUI renderer with incremental, background streaming parse |
| D11 | multiplatform-markdown-renderer | https://github.com/mikepenz/multiplatform-markdown-renderer | Apache-2.0 | 1.1k | 2026-09-08 (v0.45.0 on 2026-08-28) | Already in LeoPhoneAgent Android (0.33.0). Has a streaming API |
| D12 | Diff renderers: @pierre/diffs + git-diff-view | https://github.com/pierrecomputer/pierre · https://github.com/MrWangJustToDo/git-diff-view | Apache-2.0 · MIT | 6.2k · 740 | 2026-09-25 · 2026-08-13 | Mac diff view with annotation and accept/reject hooks |

**License note (not legal advice).** LeoPhoneAgent is GPLv3. MIT, Apache-2.0, (L)GPL-3.0 and the GPL+exception code above can be reused. AGPL-3.0 code (CloudCLI, Cherry Studio, RikkaHub, FlowDown) can be combined, but it brings the AGPL network clause; the Mac app already carries AGPL through CloudCLI. claude-watch has no license, so take ideas only.

---

## 2. Project notes

### A. Remote/mobile clients for coding agents

#### A1. Happy (slopus/happy)
- **Platforms.** iOS, Android and web from one Expo app (`packages/happy-app`). The CLI wraps the agent (`happy claude`, `happy codex`). The server can be self-hosted. A native macOS app lives in `slopus/happy-desktop` (MIT, 84★).
- **Handoff.** When the phone takes control, the session "restarts in remote mode". Pressing any key on the computer switches it back. The phone gets push notifications when the agent needs permission or hits an error.
- **Transport** (`docs/realtime-sync-and-rpc.md`):
  - One Socket.IO endpoint carries user-, session- and machine-scoped sockets.
  - RPC is routed by room membership.
  - The server "waits briefly for reconnect" before failing a call, and fails immediately if the target disappears mid-call.
  - Clients re-fetch state after reconnecting.
- **E2E encryption** (`docs/encryption.md`). The server stores only ciphertext in Postgres. The newer "data key" variant uses AES-256-GCM; the legacy variant uses NaCl XSalsa20-Poly1305.
- **Permissions.**
  - Modes: `default | acceptEdits | bypassPermissions | plan | read-only | safe-yolo | yolo`, mapped onto Claude SDK modes. Sandboxed sessions are forced to bypass (`docs/permission-resolution.md`).
  - Permission footer (`PermissionFooter.tsx`) offers: Allow; Allow all edits (switches the session to `acceptEdits`); bypass; Allow for session (stores a tool identifier such as `Bash(cmd)`); Deny.
  - Codex sessions get `approved`, `approved_for_session` or `abort` instead.
- **Layout** (`docs/layout-core.md`). Tablet and desktop use a permanent sidebar at 30% of window width, clamped to 250–360 px. Header, list and composer are centred with a max width of 800 (web) or 1400 (mac). Session rows are compact (56 px) and grouped by project.
- **Chat list** (`docs/chat-list-scrolling.md`, `chat-list-acceptance.md`):
  - It is one *inverted* FlashList, so the newest message sits at offset 0 and the keyboard and history paging need no scroll corrections.
  - Finished work collapses into a "Worked Ns" ribbon. Expanding it grows upward, anchored on the tapped row, and ends with a "Hide" row of identical height.
  - Streaming turns render flat and never fold while the user is reading.
  - Rule: "nothing on screen ever moves except by the reader's own scroll".
- **Performance budgets**, enforced by an e2e harness on the account's 10 most recent real sessions:
  - worst ChatList commit ≤300 ms (observed ≤22 ms);
  - ≤2 commits in the last 3 s of an idle session;
  - list mounted ≤2.5 s after the session opens;
  - no store batch over 50 ms.
  - House rules: "tighten, never loosen" the budgets, and add no new libraries.
- **Result presentation.** Each tool has a dedicated view (Bash, Edit/MultiEdit/Write, Todo, Task, ExitPlan, AskUserQuestion, MCP, Codex patch/diff, Gemini) in a compact and a full variant. Happy has its own diff engine with intraline highlights.
- **Diff highlighting is kept off the first paint** (`docs/mobile-diff-highlighting.md`):
  - Plain rows render first.
  - Prism tokenizes on one dedicated worklet runtime; colours appear only if ready within 1 s.
  - Results go into a 512-entry (~4 MiB) LRU.
  - Hunks over 2,000 lines or 128k characters, or with a line over 2,000 characters, stay plain.
- **Voice** (`docs/voice-architecture.md`). An ElevenLabs realtime agent handles voice. Commands go to whichever session is on screen. App events are injected either silently or as prompts. Permission requests are spoken, and prompts queue while anyone is speaking.
- **What feels fast or premium:** stable scrolling, anchored expansion, one-key device switch.
- **What is heavy:** the React Native runtime, a third-party realtime voice SDK (voice looks paid; `paid-voice.md`), and a Postgres server (Redis for scale). No Live Activity or widget code appears in the repo tree; that absence is *unverified*.

#### A2. Paseo (getpaseo/paseo)
- **Platforms.** A daemon runs agents on your machine. Clients are Expo (iOS, Android, web), Electron desktop, a CLI and a TS SDK. They connect locally, through an optional **end-to-end-encrypted relay** (QR or link pairing), or directly over TCP or Tailscale.
- **Providers:** Claude Code, Codex, Copilot, OpenCode and Pi. It also has a voice mode, skills for handing work between agents (`/paseo-handoff`, `/paseo-advisor`, `/paseo-committee`), and TypeScript plugins that run with daemon access.
- **Authorization** (`docs/permissions.md`):
  - Each principal has grants: `daemon.read`, `daemon.manage`, `tunnel.manage`, `access.manage`, `workspace.read`, `workspace.write`, `workspace.manage`, `automation.manage`, `hub.execute`.
  - Pairing invitations are single-use and expire.
  - A session can narrow its authority but never widen it.
  - Owner, operator and viewer are only UI presets.
- **Attention routing** (`agent-attention-policy.ts`):
  - A client counts as present if it was active in the last 180 s.
  - If a present client has the app visible and is focused on the agent, nothing is sent.
  - Otherwise the most recently active client gets an in-app notice.
  - A push is sent only when no client is present. Errors are never pushed.
- **Streaming** (`docs/agent-stream-performance.md`):
  - The daemon coalesces deltas, leading plus trailing, at most one message per 60 ms per agent.
  - The app reducer commits once per frame.
  - The reveal is paced from the backlog, so bursts speed up instead of jumping.
  - The store holds the full text; only the painted slice is paced.
  - Markdown is split into block rows, and only the growing last block is re-parsed.
- **Compact layout** (`docs/mobile-panels.md`). There are three mutually exclusive destinations: agent list (left), agent (centre), file explorer (right). One shared position drives them, so drawer and backdrop can never disagree.
- **Design rules** (`docs/design.md`):
  - "Minimal, spacious, quiet". Hierarchy comes from weight and colour, not size.
  - 14 px authored base (15 px default on native); 16 px content text on native.
  - One shared component per semantic element (status badge, confirm dialog, FAB with reserved clearance).
- **Presentation** (from file names in `packages/app/src`): a diff viewer drawn with native text slabs, a diff-stat pill in the composer, tool-call sheet and details, a question-form card, and a realtime voice overlay.
- **What feels fast:** written pacing and coalescing rules, presence-aware push. **What is heavy:** Expo and Electron stacks, plugins with daemon access, and a single maintainer. No Live Activity or widget code found.

#### A3. Mimi Remote (gaixianggeng/mimi-remote)
- **Platforms.** Native SwiftUI for iPhone and iPad, iOS/iPadOS 18+. On iOS 26 it uses Liquid Glass and on-device Apple Speech. The host side is a Go `agentd` for macOS, Windows and Linux, with a Mac menu-bar app and a Windows/Linux tray.
- **No relay and no accounts.** Devices connect directly over LAN or Tailscale. Pairing uses a short-lived QR code (`agentd pair --qr-only`). Each host's token is stored in the Keychain, and only one connection is active at a time.
- **Runtime.** The Codex App Server is the primary runtime: a unix control socket on Linux, SSH on macOS, a loopback WebSocket on Windows. A local `codex --remote unix://` session and the phone can open *the same thread*. The Claude Code bridge is experimental and off by default.
- **Capabilities.** Continue sessions and follow live state (thinking, waiting, failed, complete). Add context, queue the next instruction, change model or reasoning, answer prompts, approve, interrupt. Advanced: diff, worktree, stage a hunk, commit, push, open a draft PR.
- **Timeline and composer.** The timeline groups messages, reasoning, commands, tool calls and approvals. Model-generated titles arrive asynchronously and never block. Model, reasoning, Skill, speed, permission mode and queued turns all sit next to the composer.
- **Stated design principles:**
  - preserve context;
  - progressive disclosure;
  - **"show state before action"**: connection health, runtime readiness, quota and permission mode are visible before any control that can change work;
  - native layout per platform: compact iPhone, multi-column iPad, a dense 340-pt Mac menu;
  - with Reduce Motion on, movement falls back to fades.
- **Recovery:** readiness checks, reconnection, diagnostics, bounded log export. Store screenshots come only from debug-seeded data, never a real workspace.
- **What is heavy:** nothing on the device. The host needs Codex CLI ≥0.149.1. The project is young (102★).

#### A4. CodeIsland (wxtsky/CodeIsland)
- **Platforms.** A macOS 14+ notch and menu-bar app written in Swift. It shows live status, the current tool and the latest reply for 30+ CLIs, including Claude Code, Codex, Gemini, Cursor, Grok CLI, OpenCode, Qwen, Kimi, Hermes and OpenClaw. The iPhone and Watch "Buddy" (`ios/CodeIslandCompanion`) and an Android watch app are in the same repo.
- **Integration.** Each tool's hooks call a native `codeisland-bridge`, which talks over a Unix socket. Decisions for events that wait on the user travel back the same way. Tools whose hooks cannot carry a decision are shown **read-only**.
- **Approvals:**
  - approve, deny or always-allow, and answer multi-question prompts;
  - global shortcuts: ⌘⇧I toggle, ⌘⇧A approve, ⌘⇧D deny; always-allow, skip and jump are bindable;
  - auto-proceed for agents already in YOLO or Turbo mode;
  - one click jumps to the exact terminal tab or tmux pane.
- **Attention design:**
  - smart suppress: no ping while you are already looking at that session's tab;
  - quiet hours, and a "glance dot" style for completions;
  - muted while the Mac is locked or asleep;
  - a failed tool call does not ring; only a turn that dies does;
  - opt-in follow-up reminders;
  - pushes (Bark, ntfy, Slack, Telegram…) only while you are away.
- **Buddy transport** (`apple-companion/README.md`):
  - MultipeerConnectivity carries full state and commands while the app is in the foreground.
  - CoreBluetooth BLE carries compact summaries that refresh the Live Activity and Watch in the background.
  - WatchConnectivity passes state from iPhone to Watch.
  - The design deliberately uses no APNs and no backend.
- **Live Activity model** (`CodeIslandActivityAttributes.swift`). `ContentState` has `sequence`; `status` ∈ processing, running, waitingApproval, waitingQuestion, idle; tool, workspace, message, pending action, question fields; and a `sessions` preview array. Compact labels are "OK?", "Q?" and "Busy".
- **UI.** Each session card shows git branch and worktree, the agent's own task checklist as a progress bar, a "while you were away" recap, and usage and plan limits. Pixel-art mascots animate by state. Events never leave the Mac unless you opt in.
- **What is heavy:** mostly scope (mascots, 8-bit sounds, an ESP32 desk buddy). The BLE path only works nearby.

#### A5. OpenCode (anomalyco/opencode) + OpenCode iOS Client (grapeot)
- **Server.** OpenCode's TUI is itself a client of a local server. `opencode serve` listens on 127.0.0.1:4096 by default and exposes OpenAPI 3.1 at `/doc` and SSE at `/event` and `/global/event`. Basic auth is optional via `OPENCODE_SERVER_PASSWORD` (docs).
- **Session API** (docs): create, message, abort, revert and unrevert, share and unshare, **fork at a message**. Permission replies go to `/session/:id/permissions/:permissionID`.
- **Permissions** (docs):
  - Each of `read, edit, glob, grep, bash, task, skill, lsp, question, webfetch, websearch, external_directory, doom_loop` can be allow, ask or deny.
  - Bash rules use wildcard patterns; the last match wins.
  - An ask offers **`once`**, **`always`** (for the session, with a *suggested pattern*) or **`reject`**.
  - Per-agent overrides exist.
  - Defaults: allow everything except `doom_loop` and `external_directory` (ask). `read` denies `*.env`.
- **iOS client (MIT, iOS 17+, visionOS 26+).**
  - Chat with streaming, tool calls and reasoning; file tree, session diffs, and Markdown, image and code previews.
  - iPad and visionOS use a **three-column NavigationSplitView** (sidebar, file preview, chat); iPhone uses tabs.
  - On a hardware keyboard, Enter inserts a newline and Send is a button. CJK IME marked text commits normally.
  - Remote access is LAN by default, or HTTPS with basic auth, or a built-in SSH tunnel (Citadel). The quota UI reads a cached snapshot and **never polls**.
  - It depends on pinned forks of MarkdownUI and NetworkImage to build for visionOS, which shows the cost of relying on a maintenance-mode renderer.
- **What is heavy:** nothing notable on the phone. A Node/Bun server runs on the host. Other community clients (Expo-based opencode-mobile, getopencode.app) exist but were not examined.

#### A6. CloudCLI / Claude Code UI (siteboon/claudecodeui)
- **Platforms.** A responsive web UI for Claude Code, Cursor CLI and Codex (the GitHub description also lists OpenCode). A desktop companion sits in the menu bar or tray. Installed from npm as `@cloudcli-ai/cloudcli`.
- It finds existing sessions automatically, and resumes and manages several sessions at once.
- Built-in panels: shell, file explorer with editing, git explorer (stage, commit, switch branch), and browser-use sessions.
- **Safe default:** every Claude Code tool is *disabled* until you turn it on in a Tools Settings modal.
- A plugin system adds tabs with their own frontend and an optional Node backend (examples: web terminal, scheduler, hang watcher).
- The model list is fetched at runtime (`GET /api/providers/:provider/models`).
- **Relevance:** it is the base of the LeoPhoneAgent Mac app, so upstream fixes flow down. Its mobile web UI is a baseline that the native apps already exceed.
- **What is heavy:** a Node server, plus an optional Docker/microVM sandbox and a paid cloud tier (neither relevant).

#### A7. Nimbalyst (nimbalyst/nimbalyst)
- **Platforms.** A desktop app for macOS, Windows and Linux plus an **iOS companion** (the GitHub description also mentions Android). It replaced Crystal, whose README now says "Crystal is now Nimbalyst".
- **Agents.** Codex and Claude Code, with OpenCode and Copilot in alpha. Each session runs in its own git worktree. Sessions sit on a kanban board and can be searched and resumed.
- **Review.** Red/green diffs are drawn inside the rendered document, with accept or reject per edit.
- MCP tool results are rendered as **widgets rather than raw JSON**.
- **iOS companion:**
  - a dashboard of which agents need you and which are still working;
  - reply by text or voice ("agents resume immediately");
  - **swipe through diffs and tap to approve**;
  - **queue the next task**;
  - a push when an agent is waiting.
- One `EditorHost` contract serves every editor, built-in or third-party.
- **What is heavy:** anonymous PostHog analytics are on by default (opt-out), and the desktop bundles WYSIWYG editors, Excalidraw and Monaco.

#### A8. Agent Client Protocol (ACP) + claude-agent-acp
- A JSON-RPC protocol between clients (editors and apps) and coding agents.
- **Sessions** (docs): `session/new` takes a cwd and MCP servers. `session/load` makes the agent replay the whole history as `session/update` events. `session/resume` reconnects without replay (capability-gated). `session/close` and `session/cancel` end or stop work.
- **Tool calls** (docs): `tool_call` and `tool_call_update` carry:
  - `toolCallId` and `title`;
  - `kind`: read, edit, delete, move, search, execute, think, fetch, switch_mode, other;
  - `status`: pending, in_progress, completed, failed;
  - `content`: blocks, **diffs** (path, oldText, newText) or a **live terminal** (`terminalId`);
  - `locations` (path + line) so the client can follow along.
- **Permissions** (docs): `session/request_permission` offers options of kind `allow_once`, `allow_always`, `reject_once`, `reject_always`. The outcome is `selected` (with an optionId) or `cancelled`.
- **Coverage** (docs). ACP-native agents include Gemini CLI, Copilot, Cursor, Goose, OpenCode, OpenHands, Hermes Agent, OpenClaw, Kimi CLI, Qwen Code, Cline and Factory Droid. Adapters cover Claude (`claude-agent-acp`), Codex (`codex-acp`) and Pi (`pi-acp`). Grok CLI is not listed (*unverified*).
- **Relevance.** One adapter layer on the Mac could turn Claude Code, Codex, Cursor and others into one tool-call and approval model. The phone then maps `kind` to an icon, `diff` to the diff view and `terminal` to a live log.
- **Cost:** adapters run on the Mac (claude-agent-acp needs Node). Nothing changes on the phone.

#### A9. Codex app-server (openai/codex)
- The structured JSON-RPC server that Codex's rich clients use. Mimi Remote reaches it over the unix control socket (`~/.codex/app-server-control/app-server-control.sock`), over SSH, or over a loopback WebSocket.
- **Schema** (`codex-rs/app-server-protocol/schema/typescript/v2`): `ThreadStart/Resume/Fork`, `TurnStart/Interrupt`, the `ItemStarted` and `AgentMessageDelta` notifications, and the `CommandExecutionRequestApproval`, `FileChangeRequestApproval` and `PermissionsRequestApproval` requests.
- **Command approval decisions:** `accept`, `acceptForSession`, `acceptWithExecpolicyAmendment` (a persisted rule), `applyNetworkPolicyAmendment`, `decline`, `cancel`.
- **File-change decisions:** `accept`, `acceptForSession`, `decline`, `cancel`.
- The README also covers thread rollback, MCP App UI, and an experimental native user-verification step for approvals (`userVerification/verify` and `userVerification/cancel`).
- **Relevance.** This is the exact mapping target for LeoPhoneAgent's allow once / session / always / deny. "Always" becomes an execpolicy amendment; "Deny and stop" becomes `cancel`.
- **Cost:** none on the phone. The relay speaks JSON-RPC instead of scraping a TUI.

#### A10. VibeTunnel (amantus-ai/vibetunnel)
- **Platforms.** A macOS menu-bar app (Apple Silicon only) plus an npm server for Linux and headless machines. The dashboard is at `localhost:4020`.
- `vt <cmd>` forwards any terminal session to the browser and resolves shell aliases; `vt --shell` opens an interactive shell.
- Session activity indicators show active or idle, and git follow mode tracks the branch. Keyboard capture is smart, with ⌘1…9 to switch sessions.
- Authentication modes and remote-access options exist (not read in detail). An iOS app was not mentioned in the sections read (*unverified*).
- **Relevance:** raw terminal mirroring is the right *fallback* for CLIs with no structured API.
- **What is heavy:** a Node server and browser-side terminal rendering.

#### A11. Agent Watch / claude-watch (shobhit99/claude-watch)
- **No license file**, so ideas only, no code reuse.
- A Node bridge on the Mac receives Claude Code HTTP hooks (PostToolUse, PermissionRequest, Stop…) and streams them over SSE. `PermissionRequest` **blocks until the Watch or phone answers**.
- Pairing uses a 6-digit code plus a session token, with Bonjour discovery. The Watch can connect straight over Wi-Fi, but the README asks users to turn off Private Wi-Fi Address for mDNS, which is fragile.
- **iPhone app:** pairing, status, terminal preview, approvals (Yes / Yes all / No). It relays to the Watch over WCSession.
- **Watch app:** live terminal lines (Read, Edit, Bash, Grep), every permission option as a scrollable button, dictation for commands, and **haptics for completion, approval and error**.
- **Relevance:** it confirms that approvals plus haptics are the core of a Watch client. LeoPhoneAgent's route through the iPhone or relay is sturdier than mDNS.

### B. General agent apps

#### B1. OpenMinis (upstream)
- GPL-3.0. The public repo mirrors a private tree and accepts no PRs. Android 1.13 shipped on 2026-09-01; iOS ships through the App Store and TestFlight.
- **Platforms.** iOS in Swift/SwiftUI with share, widget and file-provider extensions; Android in Kotlin/Compose with JNI.
- **Capabilities:**
  - bring your own model;
  - an on-device Alpine sandbox (an ARM64 fork of iSH on iOS, PRoot on Android);
  - device integrations exposed as tools: Health, Calendar, Reminders, Contacts, HomeKit, Bluetooth, Clipboard, Media, Alarms;
  - browser automation, skills and memory;
  - workspaces addressable through `minis://workspace/`, and "native offloads" for heavy work.
- **Skills.** A skill is a `SKILL.md` folder loaded on demand. The README says skills built for Claude, Codex, OpenClaw or Hermes "generally run as-is".
- **Published specs:** the debug-server API, an iSH sandbox summary, and the URL scheme.
- **Dependencies:** SwiftAnthropic, SwiftMath, RealTimeCutVADLibrary and swift-cmark on iOS; OkHttp, Coil, multiplatform-markdown-renderer, Reorderable, ACRA and Shizuku-API on Android; KaTeX, FFmpeg/LAME and cppjieba shared.
- **Relevance:** keep syncing it (LeoPhoneAgent has `docs/UPSTREAM_SYNC.md`). Nothing new here for domain A beyond what the fork already has.

#### B2. OpenClaw (openclaw/openclaw)
- **Platforms.** A Node Gateway plus companion apps for macOS, iOS, Android, Windows, Linux and watchOS, with 20+ chat channels. 390k★.
- **Security framing:** "trusted gateway, untrusted execution, deterministic policy". Unknown DM senders must be paired and approved. Tools run on the host unless sandboxing is configured.
- **iOS node** (docs):
  - connects over WebSocket, found via Bonjour, Tailscale DNS-SD or a manual host;
  - pairs with a QR or setup code, and supports several gateways;
  - exposes screen snapshot, camera, location, Talk mode, Voice wake, and optional HealthKit summaries (which need both the iOS permission and Gateway authorization);
  - read-only workspace browsing with highlighted previews.
- **Chat** (docs):
  - one surface for text and voice;
  - an **offline queue of up to 50 messages with durable retries**;
  - dictation, voice notes, and an inline Talk control with live levels;
  - **completed turns fold into a "Worked" disclosure**;
  - inline images and Mermaid.
- **Approvals** (docs). An approval inbox shows sanitized previews. Native question cards support single or multi-select with an **expiry countdown**. Pushes go through a relay service bound to each Gateway.
- **Watch** (docs):
  - "Talk to Claw" relays dictation through the iPhone and reads the reply in the system voice;
  - "Talk on Watch" is standalone realtime WebRTC, which needs its own pairing and a reachable `wss://` endpoint;
  - approvals and questions reach the Watch through the iPhone.
- **Exec approvals** (docs):
  - two layers: a security mode (deny, allowlist, full) and an ask mode (off, on-miss, always), combined into presets;
  - stored in SQLite;
  - the macOS panel shows agent, host, working directory, the full wrapped command and an expandable Details section;
  - buttons: **Allow Once (⌘↩)**, **Always Allow Here** (bound to the directory), **Don't Allow (Esc)**;
  - **`askFallback` defaults to deny** when no UI answers;
  - allowlists are globs plus an optional argument regex.
- **Canvas** (docs). `show_widget` with `presentation.target: "node_panel"` shows HTML widgets in a borderless macOS panel near the menu bar or cursor. The panel is **render-only** and shows one widget at a time. A2UI widgets go to session dashboards.
- **What is heavy:** enormous scope (channels, nodes, plugins) on a Node runtime. Use it as a reference for policy and UX, not as code to embed.

#### B3. Hermes Agent (NousResearch/hermes-agent)
- **Platforms.** Python, with a CLI/TUI and one gateway for Telegram, Discord, Slack, WhatsApp and Signal. There is a Hermes Desktop app and a signed Termux APT repository for Android.
- **Learning loop:**
  - agent-curated memory with periodic nudges;
  - **it creates skills on its own after complex tasks**, and skills improve with use;
  - **FTS5 session search with LLM summaries**;
  - Honcho user modelling;
  - compatible with the agentskills.io format.
- A built-in cron delivers results to any platform. Subagents run in isolation. **Python scripts can call tools over RPC**, turning a multi-step pipeline into a single turn.
- Seven terminal backends: local, Docker, SSH, Singularity, Modal, Daytona, Vercel Sandbox.
- **TUI:** multiline editing, slash-command autocomplete, interrupt-and-redirect, streaming tool output.
- **Relevance:** FTS-based recall and "save this run as a skill" are cheap wins. LeoPhoneAgent inherits skill compatibility through OpenMinis.
- **What is heavy:** a Python, Node and uv toolchain, and a server-first design.

#### B4. goose (aaif-goose/goose)
- **Platforms.** A desktop app and a CLI. Moved from `block/goose`.
- **Permission modes:** Completely Autonomous (**the default**), Manual Approval, **Smart Approval** (low-risk actions run automatically, others are flagged), Chat Only. Modes can change mid-session (`/mode auto|smart_approve|approve|chat`).
- **Per-tool overrides:** Always Allow, Ask Before, Never Allow.
- The docs warn: **"goose performs best with fewer than 25 total tools enabled."**
- **MCP Apps.** App UIs render inline in chat or in standalone sandboxed windows, and an Apps page lists custom and imported HTML apps. An app can call tools but cannot talk to goose through chat.
- Recipes, subrecipes (which can run in parallel) and smart context management exist but were not read in detail.
- **Takeaway:** risk-tiered approvals and a small toolset are worth copying; being autonomous by default is not.

#### B5. OpenHands (OpenHands/OpenHands)
- **Platforms.** Web app, CLI and SDK. The runtime sandbox is Docker, which is heavy and does not apply to phones.
- Every action carries a risk level: LOW, MEDIUM, HIGH or UNKNOWN (SDK docs).
- **Analyzers:**
  - `LLMSecurityAnalyzer`: the model annotates the risk while it generates the action;
  - `PatternSecurityAnalyzer`: deterministic checks for `rm -rf`, `eval`, `curl|sh`;
  - `PolicyRailSecurityAnalyzer`: composed threats such as fetch piped into exec;
  - `EnsembleSecurityAnalyzer`: takes the highest risk.
- **Policies:** `AlwaysConfirm`, `NeverConfirm`, `ConfirmRisky`. The run pauses in `WAITING_FOR_CONFIRMATION`, and a rejection sends feedback back to the agent (`reject_pending_actions`).
- It is listed as an ACP agent. Its UI was not examined in this pass.
- **Relevance:** a deterministic check plus a model-supplied risk field, combined as "take the maximum", is a lean way to do smart approval on-device.

#### B6. LibreChat (LibreChat-AI/LibreChat)
- **Platforms.** A self-hosted web app with agents, MCP, skills and many providers.
- **Resumable streams** (docs):
  - every generation is a job that records its deltas;
  - after a dropped connection the server rebuilds the content and sends **one sync event**, then keeps streaming;
  - this lets you switch device mid-stream, run generations in the background, and share live viewing;
  - state lives in memory by default, or in Redis when scaled out.
- **Smooth streaming** (docs):
  - only newly arrived words on the latest message fade in;
  - code, math and citations skip the fade;
  - it honours `prefers-reduced-motion`;
  - nothing replays after a reconnect;
  - an **elapsed-time counter** shows under a streaming reply.
- **Artifacts** (docs). React, HTML, SVG, Mermaid and Markdown render in a Sandpack iframe (CodeSandbox CDN by default; the bundler can be self-hosted). Mermaid appears as a compact inline card that expands into the artifact panel.
- **Takeaway:** resumability and restrained animation are contracts between server and client, not UI tricks.
- **What is heavy:** artifacts depend on Sandpack and a CDN, and the whole thing needs a server.

#### B7. Open WebUI (open-webui/open-webui)
- **License and platform.** Custom "Open WebUI License". Python backend plus a web UI.
- **Code execution** (docs): Python in the browser or through "Open Terminal". Native function calling.
- **Extensibility** (docs): tools and functions written in Python with a built-in editor; Pipelines for filters and providers; MCP over Streamable HTTP.
- **Memory** (docs): facts remembered across chats; notes injected as context; channels shared by humans and models.
- **Voice** (docs): speech-to-text, text-to-speech, and **hands-free voice and video calls**. Web search cites sources.
- **Relevance:** a feature checklist only. It is server-centred and not a source of mobile patterns.

#### B8. Cherry Studio (CherryHQ/cherry-studio)
- **Platforms.** A desktop app for Windows, macOS and Linux. The roadmap lists Android and iOS "Phase 1" (status *unverified*).
- **Models.** Many providers, including local ones (Ollama, LM Studio). 300+ preset assistants, and **several models answering at once**.
- **Features:** MCP server support, Mermaid, code highlighting, full Markdown, WebDAV backup, global search, topic management, mini-programs.
- **Look:** themes (Aero, PaperMaterial, "Claude dynamic-style"), a transparent window, drag-to-sort.
- The GitHub description now mentions autonomous agents (not examined).
- **Relevance:** a peer for the Mac app. **What is heavy:** a very large feature surface.

#### B9. AnythingLLM (Mintplex-Labs/anything-llm) + AnythingLLM Mobile
- **License and platforms.** Desktop and server are MIT. Mobile is GPL-3.0, built in React Native with llama.rn, and ships on Android through Google Play.
- **Intelligent tool selection** (docs, via a search summary):
  - a ~22.6 MB cross-encoder (ms-marco-MiniLM-L6-v2, GGUF) scores tool definitions against each prompt and keeps the top N;
  - it loads on demand and adds 100–500 ms per chat;
  - it claims "up to 80%" token savings and is on by default;
  - it was ported to mobile (anythingllm-mobile PR #57).
- **Other features:** automatic and user-managed memories (global or per workspace), scheduled tasks, no-code agent flows, MCP.
- **Mobile framing:** "your phone is the agent harness". The model can run on the device, on the LAN (LM Studio, AnythingLLM Desktop, llama.cpp) or in the cloud; tools, documents and chats stay on the device.
- **Mobile features:**
  - on-device RAG, and agentic web search with citations;
  - generates Word, PDF and PPT files;
  - background jobs that notify when done;
  - **"Ask with AnythingLLM" from the text-selection toolbar**;
  - a Hugging Face model browser with a "fits your phone" badge; chat export.
- **What is heavy:** on-device models (hundreds of MB to GB), and the reranker adds another model file.

#### B10. Operit (AAswordman/Operit)
- **Platforms.** LGPL-3.0, Android. A separate successor, "Operit 2", uses a Rust runtime with Flutter clients for Android, iOS, desktop and web.
- **Per-tool permissions:** Allow automatically, Ask every time, Deny. **The default is Ask.**
- **Android control:** Accessibility, Shizuku (ADB-level) or Root; visual PhoneAgent/AutoGLM actions; virtual displays where the device permits.
- **Browser:** a built-in browser with tabs, history, downloads and user scripts. Its browser agent can inspect page structure, click, type, scroll, send keys and take screenshots.
- **Sandbox and dev tools:** Ubuntu 24.04 ARM64 through PRoot (chroot optional); multiple terminals, SSH/SFTP, project templates, an editor, live previews and change tracking.
- **Memory:** several graph-based memory spaces with temporal, semantic and relational retrieval. "Characters" each get their own models, memory, tool packages, skills and MCP.
- **Local inference:** MNN and llama.cpp GGUF.
- **Relevance:** the closest peer to LeoPhoneAgent's Android Power flavor, and a warning about scope creep.

#### B11. RikkaHub (rikkahub/rikkahub)
- **Platforms.** A native Android LLM client (AGPL-3.0) with Material You and dark mode.
- **Agent features:** a proot-based Linux "Workspace"; MCP; custom agents; ChatGPT-style memory.
- **Rendering:** Markdown with code highlighting, LaTeX, tables and Mermaid; message branching.
- **Search and prompts:** many search providers (Exa, Tavily, Brave, Perplexity…); prompt variables; custom headers and request bodies.
- **QR export and import of provider configs.** Convenient, but a QR that holds API keys is sensitive.
- "Web access for multi-platform use" (details *unverified*). The README warns about forks that request excessive permissions.

#### B12. FlowDown (Lakr233/FlowDown)
- **Platforms.** Native Swift and UIKit for iPhone, iPad and Mac. Models come from OpenAI-compatible APIs, local MLX, or Apple Intelligence.
- It collects zero data, syncs through iCloud, and integrates with Shortcuts. It can be the default translation app, and imports and exports `.fdmodel` configs.
- **Extracted libraries (all MIT):**
  - `LanguageModelChatUI`: a UIKit chat UI with streaming, tool calling, vision, speech-to-text and Markdown;
  - `MarkdownView` and `Litext`: the renderer.
- **Background streaming.** The README links it to Live Activity "with sound effects enabled". The code declares `UIBackgroundModes` → `audio` and sets `AVAudioSession` `.playback` + `.mixWithOthers` (verified in `Info-iOS.plist` and `SoundEffectPlayer.swift`). In other words, it keeps running by playing audio.
- **What feels fast:** UIKit throughout, and Markdown streaming that is throttled.
- **What is heavy:** optional MLX models, and the audio keep-alive (a battery and App Review risk).

#### B13. Open Interpreter (openinterpreter/openinterpreter)
- It is now a **Rust fork of OpenAI Codex** aimed at low-cost models. The old OS-control "01" device repo has been dead since 2024-11.
- **"Harness emulation":** `/harness` switches between native, claude-code, claude-code-bare, zcode, kimi-code, kimi-cli, qwen-code, deepseek-tui, swe-agent and minimal.
- It is ACP-compatible (`interpreter acp`) and compatible with the Codex SDK.
- **Takeaway:** tool and prompt conventions matter per provider. Cheaper models do better inside the harness they were tuned for.
- **Relevance:** LeoPhoneAgent's bring-your-own-key providers (DeepSeek, Kimi, Qwen through OpenRouter) could get provider-specific tool formats and prompts inside model groups.
- **What is heavy:** nothing that affects the phone; it is a desktop CLI.

### C. System-control agents

#### C1. Mobilerun (ex-DroidRun) + Mobilerun Portal
- **Platforms.** The framework is Python (MIT). The Portal is an Android app under its own license. iOS works through an "iOS Portal flow" (details *unverified*).
- **Perception:** accessibility trees plus screenshots (`--vision` is optional). A `--reasoning` mode handles multi-step tasks; step limits apply; runs can be traced (Phoenix, Langfuse).
- **Extensibility:** **"app cards"** (guidance written for a specific app), custom tools, structured output, stored credentials, and macro replay.
- **Portal overlay:** it highlights clickable, checkable, editable, scrollable and focusable elements, so the user sees what the agent sees.
- **Portal local APIs:**
  - HTTP (port 8080), WebSocket JSON-RPC (port 8081) and a ContentProvider, protected by an auth token;
  - a reverse WebSocket for cloud control, WebRTC screen streaming, and notification events with per-event toggles;
  - APK install from a URL with **optional auto-accept (risky)**.
- **Relevance:** the overlay and app cards are cheap wins for Android Power.

#### C2. Open-AutoGLM (zai-org/Open-AutoGLM)
- **Platforms.** A phone-agent model and a Python framework. Android through ADB (plus ADB Keyboard for typing), HarmonyOS through HDC, iPhone through WebDriverAgent. ADB and HDC also work over Wi-Fi.
- **Actions:** Launch, Tap, Type, Swipe, Back, Home, Long Press, Double Tap, Wait, and **`Take_over`**, which asks a human to take over for login or CAPTCHA.
- **Built-in hooks:** a confirmation callback for **sensitive operations** (`confirmation_callback`) and a takeover callback (`takeover_callback`).
- Its app list targets Chinese apps (WeChat, Taobao, Meituan, 12306, Xiaohongshu…). Midscene.js supports the AutoGLM model.
- Last push was 2026-03-06, so activity is slowing.
- **Relevance:** "Your turn" and sensitive-operation confirmation deserve to be first-class actions.

#### C3. mobile-mcp (mobile-next/mobile-mcp)
- **Platforms.** An MCP server for iOS and Android simulators, emulators and real devices. It needs Xcode command-line tools or Android platform-tools on a computer.
- **"Accessibility-first: fast and cheap."** It reads the native accessibility tree, with no vision model and no image tokens. Screenshots with coordinates are only a fallback.
- Output is structured and deterministic; it lists elements with their coordinates.
- **`mobile_batch_commands`** runs several actions in one call and can list the screen's elements at the end.
- It also covers device logs, crash reports, screen recording, installing and launching apps, location and orientation, and the clipboard.
- **Relevance:** the principle and the batching, not the code; it cannot run on the phone itself.

#### C4. Midscene.js (web-infra-dev/midscene)
- **Platforms.** JS/TS, for web (Playwright, Puppeteer), Android, iOS, HarmonyOS and desktop. Other targets plug in through screenshot and action adapters.
- **Vision-first:** it finds elements by how they look, through `aiAct`, `aiWaitFor` and `aiAssert` in natural language.
- **Each run produces an HTML report** with screenshots, actions and assertion results.
- It argues screenshots are cheaper than large DOM trees: on AppControlBench, 60 tasks cost $0.59 in total with Doubao Seed 2.1 Turbo, with 58 passes.
- Supported models include Qwen3.x, Doubao-Seed, GLM-V, Gemini Flash, UI-TARS and AutoGLM. Planning and vision can use different models, and DOM input is opt-in for extraction.
- **Takeaway:** a step-by-step replay is a good way to present an automation run.

#### C5. UI-TARS-desktop / Agent TARS (bytedance/UI-TARS-desktop)
- **Platforms.** UI-TARS Desktop, a desktop app with local and remote computer and browser operators, and Agent TARS, a CLI plus web UI.
- A hybrid browser agent that can use GUI visual grounding, the DOM, or both.
- v0.3.0 (2025-11) added streaming display for several tools (shell, multi-file structured output), **timing statistics for tool calls and deep thinking**, and an **Event Stream Viewer** for debugging.
- It supports MCP tools and an all-in-one agent sandbox.
- **What is heavy:** it needs a GUI vision model (UI-TARS), and the desktop app is large.

#### C6. PhoneAgent (rounak/PhoneAgent)
- **Platforms.** A SwiftUI iPhone app, an **XCTest-hosted RPC server** (JSON-RPC on 127.0.0.1:45678), and an Android bridge over adb.
- **Actions:** `get_tree`, `get_screen_image`, `get_context`, `open_app`, `tap`, `tap_element`, `enter_text`, `scroll`, `swipe`, `stop`.
- Controlling other iOS apps requires running the XCTest runner from Xcode, which is a developer setup and **cannot ship on the App Store**.
- **In-app agent:** OpenAI Responses API, the key in the Keychain, input from keyboard or microphone, and an optional always-on wake word.
- **"Notification completion + quick-reply follow-up loop."**
- The RPC listens on localhost only; physical devices use localhost forwarding.
- **Takeaway:** on iPhone, skip cross-app control. Notifications with quick reply are the part that ports.

#### C7. Peekaboo (openclaw/Peekaboo)
- **Platforms.** A macOS 15+ CLI, a menu-bar app and an MCP server (npm), written in Swift.
- **Loop:** `see` returns a structured map of the UI with opaque element IDs. Actions: click, type, press, scroll, drag, set-value. Control covers apps, windows, menus, the menu bar, the Dock, dialogs and Spaces.
- **Input is delivered in the background** to the resolved process, so the app does not have to be frontmost. The Agent/MCP policy is background-only and requires a fresh, exact snapshot.
- **Foreground actions need explicit consent.** Keystrokes with no target, or with only an app or PID, require `--allow-foreground`. You can pin actions to a `--window-id`, and semantic actions such as `menu click` are preferred.
- **Permissions:** Screen Recording, Accessibility, plus one more for synthetic input. `peekaboo permissions status` reports them, and the menu-bar app handles onboarding and visual feedback.
- **Takeaway:** automation started from the phone must never take over the user's active Mac desktop by default.

#### C8. iMCP (mattt/iMCP)
- **Platforms.** A macOS 15.3+ menu-bar app with a bundled `imcp-server` for MCP clients.
- **Services:** Calendar, Contacts, Location, Maps, Messages, Phone (calls start with a system confirmation), Reminders, Shortcuts, Weather.
- **Each service starts grey.** Clicking it raises the macOS permission prompt; once active it turns colour.
- **A client's first connection shows an approval dialog.**
- There is a one-click "Configure Claude Desktop", plus CLI instructions for Claude Code, Cursor and Amp.
- The app stores nothing itself, but clients do send data off the device when they call tools (README).
- **Takeaway:** show permission state as a visible palette, and approve each new client once.

#### C9. Stagehand (browserbase/stagehand)
- **Platforms.** A TS SDK, with Python and Go examples in the README. Built for Browserbase's cloud but runs locally.
- **Primitives:** `act()` performs a natural-language action and "self-heals" after a site redesign; `extract()` returns schema-validated data; `observe()` returns real selectors; `agent()` runs a task.
- **Credential pattern:** `observe()` finds the email and password fields so that "credentials never reach the model"; the application fills them in.
- Caching and replay details were not read (*unverified*).
- **Takeaway:** the model finds the field; the app fills the secret.
- **What is heavy:** a CDP/Playwright stack, and a cloud upsell.

#### C10. Playwright MCP (microsoft/playwright-mcp)
- An MCP server built on Playwright's accessibility tree: "no vision models needed", and deterministic.
- The README now **recommends Playwright CLI plus skills for coding agents**, because CLI calls avoid loading large tool schemas and accessibility trees into the model's context.
- **Opt-in capabilities:** `--caps vision,pdf,devtools`. Also `--isolated` (in-memory profile) and `--snapshot-mode full|none`.
- `--allowed-origins` and `--blocked-origins` are explicitly "not a security boundary".
- `--mobile` emulation, because "Mobile pages are usually lighter, which saves tokens".
- **Takeaway:** keep the default tool surface small. LeoPhoneAgent's in-app browser already gets mobile pages for free.

#### C11. agent-browser (vercel-labs/agent-browser)
- **Platform.** A native Rust CLI and daemon over Chrome for Testing; no Playwright or Node needed at runtime.
- **Snapshots:** `snapshot` returns the accessibility tree with refs like `@e1`; `get text @e1` reads one; `batch --bail` runs several commands.
- **Screenshots:** `screenshot --annotate` draws numbered element labels, and **`screenshot --if-changed` skips unchanged images "to save tokens"**.
- WebMCP tools found on a page are announced as short summaries; the full schema is fetched only when needed.
- **Untrusted page content** is wrapped in content boundaries that carry a nonce. Safeguards include `--allowed-domains`, `--content-boundaries` and `--max-output`.
- **Takeaway:** lean perception, and clear marking of what is untrusted.

### D. Result presentation / generative UI

#### D1. MCP Apps (ext-apps) + MCP-UI
- **License.** ext-apps is the official MCP extension and is moving from MIT to Apache-2.0. MCP-UI is an Apache-2.0 SDK that "implements the MCP Apps standard".
- **How it works:** a tool points to its UI with `_meta.ui.resourceUri`, a `ui://` resource with MIME type `text/html;profile=mcp-app`. The host fetches it with `resources/read` and renders it in a **sandboxed iframe**.
- **Two-way:** the host passes tool input and results to the view, and the view can call other tools through the host. The `AppRenderer` props include `onOpenLink`, `onMessage` and a sandbox proxy URL.
- **Hosts:** Claude, ChatGPT and other compliant clients render these inline. goose supports inline and standalone windows, and the Codex app-server README documents MCP App UI.
- The wire protocol is unchanged between ext-apps 1.x and 2.x. The repo ships agent skills such as `create-mcp-app` and `migrate-oai-app`.
- **Cost:** it needs a full web view plus a sandbox proxy. Fine on the Mac (Electron already has Chromium), heavy on iPhone and Watch.

#### D2. A2UI (a2ui-project/a2ui)
- **Status.** The production release is v0.9.1, and the v1.0 spec is a release candidate ("early stage public preview").
- The agent sends declarative JSON describing its intent. The client renders it with **its own catalog of trusted components**: "safe like data, but expressive like code".
- **The UI is a flat list of components that reference each other by ID**, which makes incremental generation and progressive rendering easy.
- It runs over A2A or AG-UI. "Smart wrappers" can map custom native components, including sandboxed iframes.
- **Renderers:** Angular, Lit, React and Flutter, plus an **official Swift implementation** (`A2UISwiftCore`, `A2UISwiftUI`, `BasicCatalogSwiftUI`) for iOS, iPadOS, macOS, tvOS, visionOS and **watchOS**, with a sample gallery app. Kotlin has only a legacy agent SDK.
- **Relevance:** the best reference for a native generative UI limited to a catalog, on iPhone and Watch alike.
- **Cost:** copying the format costs nothing. Using the Swift package means depending on a spec that is still changing.

#### D3. json-render (vercel-labs/json-render)
- You define a catalog: components with Zod-validated props, plus named actions. The model emits JSON that must fit it. The pitch is "Guardrailed, Predictable", and it streams and renders progressively.
- **Renderers:** React, **React Native**, Vue, Svelte, Solid, Ink (terminal), React-PDF, email, Remotion and R3F. It ships 36 prebuilt shadcn components.
- There are also YAML, codegen and devtools packages.
- **Relevance:** the same catalog idea as A2UI with simpler JSON. Its validation approach carries over to Swift and Kotlin.
- **What is heavy:** it is JavaScript only.
- **Takeaway:** validate the model's UI JSON against a schema, and fall back to Markdown when validation fails.

#### D4. AG-UI + CopilotKit
- **AG-UI (MIT)** is an event protocol between agent backends and UIs (docs).
  - Event categories: lifecycle, text message, tool call, state management, activity, subagent, special, draft.
  - **State sync:** `StateSnapshot` replaces the whole state; **`StateDelta` carries RFC 6902 JSON Patch operations** that are applied in order.
  - **Human-in-the-loop:** `RunFinished` can carry `outcome: {type: "interrupt", interrupts: [...]}`, and the client resumes with a `resume` array that answers each interrupt.
  - Reasoning events include encrypted reasoning that carries over between turns.
- **CopilotKit (MIT)** targets React, Angular, Vue, React Native, Slack and Teams. It offers backend tool rendering, generative UI, shared state, human-in-the-loop pauses, and threads that keep their generative UI across reloads.
- **Relevance:** JSON Patch deltas suit the relay-to-Live Activity and relay-to-Watch paths, and treating an approval as an interrupt makes it a real run state.

#### D5. Vercel AI SDK + AI Elements + Streamdown
- **AI SDK** (docs). Tool calls are typed message parts, `tool-<name>`, with states `input-streaming`, `input-available`, `approval-requested`, `approval-responded`, `output-available`, `output-error`, `output-denied`. Approvals go through `addToolApprovalResponse`; client-side tools through `onToolCall` and `addToolOutput`; `sendAutomaticallyWhen` resubmits automatically.
- **AI Elements.** Shadcn-based components whose names make a useful checklist of agent UI parts: confirmation, tool, reasoning, chain-of-thought, plan, queue, task, checkpoint, context (token usage), shimmer, terminal, test-results, stack-trace, sources, inline-citation, web-preview, artifact, commit, file-tree, speech-input, transcription.
- **Streamdown** is a drop-in replacement for `react-markdown`, built for streaming:
  - it repairs unterminated blocks mid-stream (`remend`);
  - it supports GFM, KaTeX and Shiki, and renders Mermaid only when you press a button;
  - it is hardened with `rehype-harden` and memoized;
  - code, math, Mermaid and CJK support are split into **optional plugins**.
- **Relevance:** the tool-part state machine applies to every client. Streamdown is a direct swap for the Mac app's `react-markdown`.

#### D6. assistant-ui (assistant-ui/assistant-ui)
- Composable React primitives (Thread, Message, Composer, ThreadList, ActionBar) instead of one monolithic chat component.
- **Built in:** streaming, auto-scroll, retries, attachments, Markdown, code highlighting, voice dictation, keyboard shortcuts, accessibility.
- **Generative UI:** tool calls and JSON render as components, with **inline human approvals** and safe frontend actions.
- **Runtime adapters** (`useChatRuntime`, `useLangGraphRuntime`, `useDataStreamRuntime`) separate the UI from the backend.
- **Integrations:** AI SDK, LangGraph, AG-UI, A2A, Google ADK and OpenCode. Packages include `react-native`, `react-opencode`, `safe-content-frame`, `react-streamdown` and `tw-shimmer`.
- **Relevance:** a Mac reference for the approval and thread-list patterns. Not needed if the CloudCLI-based UI already has equivalents.

#### D7. OpenAI Apps SDK (examples, apps-sdk-ui, UI guidelines)
- **`@openai/apps-sdk-ui`:** design tokens plus accessible React components built on Radix, with Tailwind 4 integration.
- **Display modes** (docs): inline card, inline carousel (3–8 items), fullscreen (the composer stays), picture-in-picture.
- **Inline card rules** (docs):
  - **at most two actions, placed at the bottom**;
  - **no deep navigation or multiple views**;
  - **no nested scrolling**; cards auto-fit their content;
  - do not duplicate features the host already has.
- **Visual rules** (docs): system colours, with brand accents only on logos and icons; inherit the system font and sizing; consistent spacing; monochrome outlined icons; WCAG AA contrast; alt text on images.
- Apps SDK apps can move to MCP Apps; ext-apps ships a `migrate-oai-app` skill.
- **Relevance:** these card rules are the cheapest "premium" improvement for tool results on every device.

#### D8. Textual (successor of swift-markdown-ui)
- `swift-markdown-ui` (MarkdownUI) is in **maintenance mode**; development moved to Textual.
- Textual keeps SwiftUI's own `Text` rendering pipeline, through `InlineText` and `StructuredText`, with native text selection and copy.
- It parses with Foundation's `AttributedString` Markdown parser. Other parsers can plug in through `MarkupParser`, using `PresentationIntent`.
- **Features:** inline attachments (images, custom emoji, animated images), math as an attachment, syntax highlighting, full styling, and measurements relative to the font that follow Dynamic Type.
- The README does not mention streaming (*unverified*).
- **Relevance:** only if LeoPhoneAgent leaves its cmark-based renderer. The OpenCode iOS client had to fork MarkdownUI, which shows the risk of depending on a maintenance-mode library.

#### D9. MarkdownView (Lakr233) + LanguageModelChatUI
- UIKit/AppKit. Deliberately "not a full-spec CommonMark renderer": it favours good typography on a phone.
- **Built for streaming:** updates are throttled (**20 fps by default**) and views are reused, so calling it on every token is fine. Parsing happens off the main path; `setContent` calls are coalesced.
- **Mobile-first layout:** tables and code blocks are **lifted out of lists** and shown as full blocks.
- Code highlighting runs asynchronously (Highlightr). Math uses SwiftMath, with tap-to-preview.
- **Platforms:** iOS 16+, macOS 13+, Catalyst, visionOS, and **watchOS 8+ (`WatchMarkdownView`)**.
- **LanguageModelChatUI** (iOS 17+, Swift 6): a UIKit chat UI with streaming, tool calling, vision input, speech-to-text and Markdown, plus `ChatClientKit` for networking.
- **Relevance:** the closest design to LeoPhoneAgent's own cmark + SwiftMath stack. Borrow the throttling and the list-lifting; use `WatchMarkdownView` only if the Watch needs formatted text.

#### D10. MarkdownView (LiYanan2004)
- A SwiftUI renderer built on swift-markdown and fully CommonMark-compliant.
- **`StreamingMarkdownReader`** schedules processing, parses incrementally as chunks arrive, and parses in the background. Use one `StreamingMarkdownSource` per response and call `finishStreaming()` at the end.
- **Features:** SVG images, LaTeX, continuous text selection on iOS and macOS, block directives, custom block styles.
- **Platforms:** iOS 16+, macOS 13+, watchOS 9+, visionOS.
- **Relevance:** a SwiftUI option if a SwiftUI-native renderer is ever wanted.
- **Cost:** it adds swift-markdown as a dependency.

#### D11. multiplatform-markdown-renderer (mikepenz)
- Compose for Android, iOS and desktop. LeoPhoneAgent Android already uses it at 0.33.0; the latest release is v0.45.0 (2026-08-28).
- **Parsing is asynchronous by default** (`rememberMarkdownState`). `retainState = true` keeps the old content on screen while it re-parses.
- **`rememberStreamingMarkdownState()`** is append-only and **re-parses only the unstable tail**. `collectAsStreamingMarkdownState()` does the same for a Flow.
- **Features:** GFM tables and alerts out of the box, an optional `-code` highlighting module, Coil 2/3 image loaders, lazy loading for large documents.
- **Relevance:** the Android streaming upgrade is a version bump plus about five lines of code. The version that introduced the streaming state is *unverified*.

#### D12. Diff renderers: @pierre/diffs and git-diff-view
- **@pierre/diffs:** diff and file rendering built on Shiki, in vanilla JS and React. Split or stacked layouts; adapts to the theme; line numbers, wrapping and inline highlights.
- It has an **annotation framework for comments**, **hooks for your own accept/reject UI**, and line selection and highlighting.
- **git-diff-view (MIT)** is a GitHub-style diff component for React, Vue, Solid, Svelte and Ink (description only; not examined).
- Happy's native engine (A1) shows the mobile equivalent: plain first, highlight later.
- **Relevance:** a Mac diff view where an inline comment is sent straight back to the agent (the idea Vibe Kanban had).
- **Cost:** Shiki grammars add bundle weight, so load languages lazily.

---

## 3. Lessons for LeoPhoneAgent

Each item gives the devices it applies to, the source projects, the user benefit, and the cost or weight. Items are ordered roughly by value for cost. Items that would bloat the app are collected under **Avoid** at the end.

### Streaming, chat and result surfaces

**1. Fold finished work into one "Worked" row, and never move what the user is reading.** `[iPhone][iPad][Android][Mac]`
- **What:** a finished turn's tool calls and reasoning collapse into one row, e.g. "Worked 1m 12s · 9 steps". Expanding it stays anchored on the tapped row and ends with a "Hide" row of the same height. The live turn renders flat and never folds while streaming or while the user reads. The list is anchored at the bottom (or inverted), so the keyboard, history paging and new messages never shift the text being read.
- **Sources:** Happy (chat-list acceptance A1–A5), OpenClaw iOS ("Worked" disclosure).
- **Benefit:** calmer, shorter conversations and fewer cells to lay out, so scrolling is smoother.
- **Cost:** UI logic only. It actually reduces the number of views rendered.

**2. Coalesce on the relay, pace the reveal on the client, and re-parse only the tail.** `[all]`
- **What:**
  - The relay coalesces deltas per session: leading plus trailing, at most one message per ~60 ms.
  - The client commits at most once per frame and re-parses only the growing last Markdown block.
  - Rendering is throttled to about 20 fps, and text is revealed at a rate derived from the backlog. The store keeps the full text.
  - Only newly arrived words fade in; code and math don't. Honour Reduce Motion, and never re-animate text after a reconnect. Align the existing `TextFadeAnimator` with these rules.
  - **Android:** bump `multiplatform-markdown-renderer` from 0.33.0 to 0.45.0 and use `rememberStreamingMarkdownState()` for the live message.
- **Sources:** Paseo (agent-stream-performance), Lakr233 MarkdownView (20 fps throttle), LibreChat smooth streaming, mikepenz renderer.
- **Benefit:** "premium" smooth streaming with less CPU, less battery and fewer relay messages.
- **Cost:** no new dependencies. On Android it is a version bump.

**3. Keep syntax highlighting out of the first paint.** `[iPhone][iPad][Android][Mac]`
- **What:**
  - Diffs and code render plain at once, with their layout reserved.
  - Complete hunks are highlighted off the main thread. Swap in colours only if they are ready within about 1 s; otherwise stay plain.
  - Share one LRU cache (~512 entries, ~4 MB). Hard limits: over 2,000 lines, over 128k characters, or any line over 2,000 characters stays plain.
  - Deduplicate identical jobs and cancel on unmount.
- **Source:** Happy (mobile-diff-highlighting).
- **Benefit:** no jank when opening large diffs or files.
- **Cost:** none beyond the existing highlighter; memory is bounded.

**4. Strict rules for tool cards.** `[all]`
- **What:**
  - Inline cards fit their content, have **at most two actions at the bottom**, no nested scrolling, and no navigation inside the card.
  - "Open" goes to a sheet on iPhone and to a side panel on iPad and Mac.
  - Raw JSON only appears behind "Details".
  - Apply AI SDK-style explicit states to every card: streaming input, waiting for approval, running, done, error, denied.
- **Sources:** OpenAI Apps SDK UI guidelines, Happy (ToolView vs ToolFullView), LibreChat (inline card expanding to a panel), Nimbalyst (widgets instead of raw JSON), AI SDK tool-part states.
- **Benefit:** visual consistency, less layout thrash, a clear state on every card.
- **Cost:** none.

**5. Generative UI through a small native component catalog, not web views.** `[iPhone][iPad][Android][Mac]` (a text/KeyValue subset on `[Watch]`)
- **What:**
  - Add a `render_ui` tool whose JSON must validate against about 10 native components: Card, KeyValue, List, Table, Metric, Chart (Swift Charts or Compose Canvas), Image, Button (which triggers a tool call), and Choice/Form fields.
  - If validation fails, fall back to Markdown.
  - Use A2UI's flat "components with IDs" shape, so later updates patch individual components instead of redrawing.
- **Sources:** A2UI (catalog, flat IDs, official SwiftUI and watchOS renderer), json-render (catalog with schema-validated props), AG-UI (JSON Patch deltas).
- **Benefit:** rich native answers (tables, charts, forms) that are safe because they are data, not code.
- **Cost:** a hand-rolled catalog is small. Adopting the A2UI Swift package would add a dependency on a spec that is still changing, so copy the format rather than the library.

**6. MCP Apps on the Mac only, sandboxed and opt-in.** `[Mac]`
- **What:** render `ui://` resources in a sandboxed iframe in the Electron app. Start render-only in a popover (OpenClaw Canvas style), and allow interactive apps only after the user opts in for that server.
- **Sources:** MCP Apps / MCP-UI `AppRenderer`, goose, OpenClaw Canvas, Codex app-server (MCP App UI).
- **Benefit:** compatibility with the ecosystem's tool UIs.
- **Cost:** low on the Mac because Chromium is already bundled. Do not port this to iPhone or Watch.

### Approvals, attention and safety

**7. One approval vocabulary, mapped to each runtime, with narrowly scoped "Always".** `[all]`
- **What:**
  - Keep the four buttons and add **"Deny and stop"**.
  - Always show the exact rule that "Always" will store (pattern plus directory), and make directory scope the default.
  - Put the list of standing grants, with revoke, in Settings.
  - An unanswered approval resolves to **Deny** after a timeout.
  - Questions use the same card family: single or multi-select with an expiry countdown.
- **Mapping:**

  | Runtime | Allow once | Allow for session | Always | Deny | Deny and stop |
  |---|---|---|---|---|---|
  | Codex app-server | `accept` | `acceptForSession` | `acceptWithExecpolicyAmendment` | `decline` | `cancel` |
  | ACP | `allow_once` | – | `allow_always` | `reject_once` | cancelled outcome |
  | OpenCode | `once` | `always` (with a suggested pattern) | – | `reject` | – |
  | OpenClaw | Allow Once | – | Always Allow Here (directory-bound) | Don't Allow | – |

- **Sources:** Codex app-server, ACP, OpenCode, OpenClaw (askFallback defaults to deny; question cards with countdown), Happy (`Bash(cmd)`-style session grants).
- **Benefit:** predictable, reversible approvals across Claude, Codex, Cursor and Grok.
- **Cost:** a mapping table in the relay plus one Settings list.

**8. Risk-tiered "smart approve".** `[iPhone][Android][Mac]`
- **What:**
  - A deterministic pattern table flags `rm -rf`, `curl|sh`, `eval`, fetch piped into exec, writes outside the workspace, and secret files. Take the maximum of that and an optional `risk` field the model fills in on each tool call.
  - LOW runs automatically; HIGH always asks. Show a risk badge on the card.
  - Default to ask on reads outside the workspace and on repeated identical calls, and deny `*.env` reads.
  - Send `ToolLoopDetector` hits to an "ask" card rather than a silent stop.
- **Sources:** OpenHands (LLM risk annotation; Pattern, PolicyRail and Ensemble analyzers; `ConfirmRisky`), goose (Smart Approval; Always Allow / Ask Before / Never Allow per tool), OpenCode defaults (`doom_loop` and `external_directory` ask; `*.env` deny).
- **Benefit:** fewer interruptions without losing safety.
- **Cost:** one enum and a table of regular expressions. No dependencies.

**9. Presence-aware attention routing across devices.** `[iPhone][Watch][Mac][Android]`
- **What:**
  - Clients send tiny heartbeats to the relay: `{visible, lastActivity, focusedSession}`.
  - If a present client (active in the last ~180 s) is focused on the session, send nothing.
  - Otherwise show an in-app banner on the most recently active device.
  - Send a push only when nobody is present, and never push for errors.
  - Add quiet hours, suppression while the device is locked or the Mac is asleep, and a follow-up reminder for approvals left unanswered.
- **Sources:** Paseo (`agent-attention-policy`), CodeIsland (smart suppress, glance dot, quiet hours, pushes only while away).
- **Benefit:** no triple buzz from Mac, phone and Watch at once; notifications feel deliberate.
- **Cost:** relay logic plus tiny heartbeats over the existing sockets.

**10. Reply straight from the notification.** `[iPhone][Watch][Android]`
- **What:** add a `UNTextInputNotificationAction` "Reply" (on Android, `RemoteInput`) to the "finished" and "needs answer" notifications. Keep the approve action `.authenticationRequired`, as it already is. On the Watch this becomes dictation or Scribble with no extra code.
- **Sources:** PhoneAgent (completion notification with a quick-reply loop), Nimbalyst (reply by text or voice), CodeIsland (answer from the notch).
- **Benefit:** continue an agent from the lock screen or the Watch without opening the app.
- **Cost:** no dependencies. Today the category only has 批准一次 and 拒绝.

**11. Make the Live Activity robust.** `[iPhone][Watch]` (Smart Stack)
- **What:**
  - Add a monotonic `sequence` to `ContentState` and drop pushes that arrive out of order.
  - Set `staleDate` to roughly the last update plus two heartbeats, so a dead relay renders as "stale" (`context.isStale`) instead of "working" forever.
  - Use a fixed five-state vocabulary for the compact slots: working, running, needs approval, needs answer, idle.
  - Optionally send AG-UI-style JSON Patch deltas to keep push payloads small.
- **Sources:** CodeIsland Buddy (`sequence`, status set, the "OK?" and "Q?" labels), AG-UI `StateDelta`.
- **Benefit:** the Dynamic Island never shows something false.
- **Cost:** trivial. Today there is no sequence and `staleDate` is nil.

**12. Resumable runs, one-shot catch-up, and an offline outbox.** `[all]`
- **What:**
  - On reconnect, `RelayEventCatchUp` sends one compact sync event, then continues live, without re-animating text the user already saw.
  - Prompts and approvals typed while offline go into an outbox (bounded, e.g. 50) with durable retries and a visible "queued" state.
  - Allow "queue the next instruction" while the agent is busy.
- **Sources:** LibreChat resumable streams, ACP `session/load` vs `session/resume`, Happy (RPC waits for reconnect and fails fast), OpenClaw iOS (offline queue of 50), Mimi Remote and Nimbalyst (queue the next task).
- **Benefit:** coming back from a tunnel or a lift feels instant.
- **Cost:** bounded relay memory and a small client queue.

**13. Structured runtimes first, terminal mirroring last.** Mac relay → all clients
- **What:**
  - Drive Codex through `codex app-server`: thread start/resume/fork, turn interrupt, typed approvals.
  - Drive Claude Code through the Agent SDK or `claude-agent-acp`, OpenCode through `opencode serve`, and other CLIs through ACP where supported.
  - Keep hook or PTY mirroring as a **read-only** fallback, the way CodeIsland treats hooks that cannot carry a decision.
- **Sources:** Mimi Remote, Codex app-server, ACP, OpenCode, CodeIsland, VibeTunnel.
- **Benefit:** resume, fork, interrupt and approvals become reliable, with fewer terminal-parsing bugs.
- **Cost:** adapters run on the Mac (Node for claude-agent-acp); nothing is added to the phones. Whether Grok CLI speaks ACP is *unverified*.

**14. Scoped device credentials, plus E2E payload encryption if the relay runs on a VPS.** `[iPhone][Watch][Mac]`
- **What:**
  - Each paired device gets explicit grants, e.g. Watch = read + approve; iPhone = read + write; nobody gets "manage" by default.
  - Pairing invitations are single-use and expire; a session can narrow its authority but never widen it.
  - If the relay is not on your own hardware, encrypt payloads end to end so the relay only stores ciphertext. CryptoKit and swift-crypto are already iOS dependencies, and `javax.crypto` is built into Android.
- **Sources:** Paseo (principal → grants), OpenClaw (per-Gateway credential binding), Happy (server stores only AES-256-GCM ciphertext), Paseo's E2E relay.
- **Benefit:** a lost Watch does not mean shell access, and a compromised relay does not leak code.
- **Cost:** grants are small. E2E key management across devices is moderate work. Today the relay has HMAC token auth and no payload encryption was found.

### System control

**15. Clean up browser automation.** `[iPhone][Android][Mac]`
- **What:**
  - Perceive through a compact accessibility/DOM snapshot with stable refs (`@e1`).
  - Take screenshots only on demand, and **only if the page changed**.
  - Wrap page text in untrusted blocks delimited with a nonce.
  - Keep a domain allowlist per task.
  - Draw a numbered overlay on the element the agent is about to press, so the user sees its intent.
- **Sources:** Playwright MCP, agent-browser (`--if-changed`, `--annotate`, content boundaries, `--allowed-domains`), Mobilerun Portal overlay.
- **Benefit:** fewer tokens, faster steps, better prompt-injection hygiene, visible intent.
- **Cost:** injected JS and an overlay. No dependencies.

**16. Secrets never reach the model, and humans take over logins.** `[iPhone][Android][Mac]`
- **What:**
  - The model locates the field; the app fills the value from the Keychain or Keystore after the user confirms. Tool output is redacted.
  - At a login, CAPTCHA or payment step, the run pauses on a "Your turn" card and continues after the user taps Continue.
  - Never solve CAPTCHAs automatically.
- **Sources:** Stagehand (`observe()` so credentials never reach the model), Open-AutoGLM (`Take_over` and sensitive-operation confirmation).
- **Benefit:** safety and user trust, and it stays within App Store rules.
- **Cost:** small.

**17. Android Power: accessibility-first control, a visible overlay, and ask by default.** `[Android]`
- **What:**
  - Prefer the accessibility tree; use screenshots only for canvas or WebView content.
  - Batch several UI actions into one tool call.
  - Keep per-app "app cards" as skills.
  - Show an overlay while acting.
  - Default to "Ask every time" for tools that change the system, with per-tool Allow automatically / Ask / Deny.
- **Sources:** mobile-mcp (accessibility-first, `mobile_batch_commands`), Mobilerun (Portal overlay, app cards), Operit (per-tool permissions, ask by default).
- **Benefit:** cheaper, more reliable control, and more user trust.
- **Cost:** nothing beyond the existing Accessibility and Shizuku code.

**18. Android: an entry point in the text-selection toolbar.** `[Android]`
- **What:** register an `ACTION_PROCESS_TEXT` activity called "Ask LeoPhoneAgent".
- **Source:** AnythingLLM Mobile ("Ask with AnythingLLM").
- **Benefit:** one tap from selected text in any app.
- **Cost:** one activity and one intent filter.

**19. Mac: background-only automation by default, and a visible permission palette.** `[Mac]`
- **What:**
  - Automation started from the phone never takes focus or the foreground unless the user taps "Allow foreground" for that run.
  - Pin actions to an exact window.
  - A permission grid shows which Mac and iPhone integrations are enabled (grey vs colour), and each new client is approved once.
- **Sources:** Peekaboo (background delivery; foreground needs `--allow-foreground`; prefer semantic actions), iMCP (grey-to-colour services, first-connection approval).
- **Benefit:** the phone never takes over your Mac mid-task, and permission state is always visible.
- **Cost:** a policy flag and one settings grid.

**20. Mac: approve without switching windows.** `[Mac]`
- **What:**
  - One tray or menu-bar panel lists pending approvals across all CLIs.
  - The approval shows agent, host, working directory, the full command and a "Details" section.
  - Keys: ⌘↩ allow once, Esc deny, plus global shortcuts (e.g. ⌘⇧A approve, ⌘⇧D deny).
  - A jump-to-terminal button. The panel hides when nothing is pending.
- **Sources:** CodeIsland, OpenClaw's macOS approval panel, Mimi Remote (340-pt menu).
- **Benefit:** faster approvals at the desk.
- **Cost:** an Electron `Tray` plus `globalShortcut`. Keep it to one panel (no mascots).

**21. Mac: swap `react-markdown` for Streamdown.** `[Mac]`
- **What:** replace `react-markdown` in the CloudCLI-derived UI with Streamdown, with only the code and math plugins; load Mermaid lazily.
- **Source:** Streamdown (drop-in replacement; `remend` repair; `rehype-harden`; plugins split out).
- **Benefit:** no broken formatting mid-stream, and hardened rendering.
- **Cost:** a replacement, not an addition (Apache-2.0). Watch the bundle weight of Shiki grammars.

### Devices

**22. iPad: same capabilities, a different layout, and state shown before actions.** `[iPad]` (the "state strip" also applies to `[iPhone]`)
- **What:**
  - A NavigationSplitView with sessions | chat | files, diffs and artifacts.
  - Readable content width of about 800 pt. Sidebar about 30% of width, clamped to 250–360 pt.
  - Keyboard: ⌘↩ sends, ⌘. stops; Return stays a newline for CJK input, and IME marked text is always respected.
  - Reduce Motion falls back to fades.
  - A "state strip" next to the composer shows connection, runtime readiness, permission mode and quota. Fetch it when the screen opens rather than polling.
- **Sources:** Mimi Remote (design principles), OpenCode iOS client (three columns; hardware-keyboard rules; quota with no polling), Happy (layout-core), Paseo (mobile panels).
- **Benefit:** the iPad stops feeling like a stretched iPhone.
- **Cost:** native SwiftUI, no dependencies.

**23. Watch: glance, voice, approve.** `[Watch]`
- **What:**
  - One status line and one primary action.
  - A distinct haptic per event: done, needs approval, failed.
  - Approvals as full-width buttons, plus notification actions.
  - Text-to-speech reads a summary of at most two sentences, with "Open on iPhone" for details.
  - Plain text rendering. Add `WatchMarkdownView` only if formatted text is truly needed.
  - Keep the existing split: relay through the iPhone when it is reachable, call the API directly when it is not.
- **Sources:** claude-watch (haptics, scrollable option buttons), OpenClaw (Talk to Claw through the iPhone with system-voice readback; approvals relayed to the Watch), CodeIsland (Smart Stack widget, glance dot).
- **Benefit:** fast, premium interactions on the wrist.
- **Cost:** none.

### Memory, skills and quality

**24. Cross-session recall with SQLite FTS, and offer "save as skill" after long runs.** `[iPhone][Android][Mac]`
- **What:**
  - Index past sessions and Treasury items in an FTS table. On a hit, summarise it with the model.
  - After a run with many steps, offer "Save as skill" (the model drafts the `SKILL.md`, the user approves it).
- **Source:** Hermes Agent (FTS5 session search with LLM summaries; skills created and improved from experience).
- **Benefit:** "you did this before" recall, and reusable workflows.
- **Cost:** SQLite ships with both OSes. No SQLite use was found in the iOS sources; whether the system SQLite includes FTS5 on the target iOS version is *unverified*.

**25. Keep the default toolset small and load tool groups on demand.** `[iPhone][Android][Watch]`
- **What:**
  - Expose device-integration tools through skills or tool groups.
  - Until a tool is chosen, the prompt carries only names and one-line descriptions; fetch the full schema on demand.
  - Expose capabilities as short commands inside the existing Linux sandbox (documented in `SKILL.md`) instead of many JSON schemas.
  - Allow a single batch call for multi-step UI actions.
  - Do **not** bundle a reranker model on the phone.
- **Sources:** goose (best under 25 tools), Playwright MCP (opt-in capabilities; CLI plus skills uses fewer tokens), agent-browser (WebMCP summaries only), mobile-mcp and agent-browser (batch), Hermes (scripts call tools over RPC), AnythingLLM (reranking works, but costs a ~22.6 MB model and 100–500 ms per chat).
- **Benefit:** faster first token, lower cost, better tool choice.
- **Cost:** negative; the prompts get smaller.

**26. Performance budgets as tests.** `[iPhone][Android]`
- **What:** three or four budgets checked against the 10 most recent real sessions:
  - worst chat-list commit;
  - time from open to list shown ≤2.5 s;
  - ≤2 idle commits in 3 s;
  - store write ≤50 ms.
  - Tighten budgets over time; never loosen them to make a run pass.
- **Source:** Happy (chat-list-acceptance B1–B4).
- **Benefit:** smoothness stops regressing.
- **Cost:** test-only.

**27. Harness profiles per provider.** `[iPhone][Android][Mac]`
- **What:** for bring-your-own-key providers (DeepSeek, Kimi, Qwen and others), keep provider-specific prompt and tool-format profiles inside model groups.
- **Source:** Open Interpreter (`/harness` with claude-code, kimi-code, qwen-code, deepseek-tui…).
- **Benefit:** more reliable tool use on cheaper models.
- **Cost:** configuration only.

### Avoid (bloat or risk)

- **avoid:** embedding React Native, Expo or Flutter runtimes to reuse Happy, Paseo, AnythingLLM Mobile or Operit 2 UI inside the native apps. Binary size grows and you get a second UI stack.
- **avoid:** generative UI in web views or iframes (MCP Apps, Sandpack artifacts) on iPhone and Watch. Use the native catalog (lesson 5) and keep web UIs on the Mac.
- **avoid:** keeping streams alive with the audio background mode, as FlowDown does (`UIBackgroundModes` audio plus `.playback`). It costs battery and invites App Review trouble. Use relay plus push (already in place) instead.
- **avoid:** vision-first screen control as the default (Midscene, UI-TARS, Agent-S). Image tokens and latency add up. Use the accessibility tree first and vision as a fallback.
- **avoid:** bundling on-device rerankers or LLMs in the main binary (AnythingLLM's ~22.6 MB reranker; MLX or GGUF models). Offer them as optional downloads at most, and never on the Watch.
- **avoid:** realtime WebRTC voice on the Watch (OpenClaw's "Talk on Watch") and third-party realtime voice SDKs as defaults (Happy uses ElevenLabs). Battery drain and extra dependencies; opt-in only.
- **avoid:** mascots, 8-bit sounds and hardware buddies (CodeIsland). Fun, but pure scope creep.
- **avoid:** VM or Docker computer-use sandboxes (cua, OpenHands runtime, CloudCLI's sandbox mode). Heavy, and outside the product's form.
- **avoid:** CAPTCHA solving or stealth browsing (browser-use cloud). It conflicts with the safety posture and site terms of service.
- **avoid:** full code editors on mobile (Runestone, Monaco). A read-only preview plus diff is enough.
- **avoid:** cross-app iPhone control through XCTest or WebDriverAgent in the shipping app (PhoneAgent, AutoGLM). It needs Xcode; if wanted at all, make it a developer-mode Mac feature.
- **avoid (for now):** graph memory plus "characters" (Operit). Do FTS recall (lesson 24) first.

---

## 4. Checked and rejected

| Project | Reason |
|---|---|
| omnara-ai/omnara | Pivoted to a managed-agents API platform ("open-source alternative to Claude Managed Agents"; Go + Postgres, Docker Compose). It is no longer a mobile client for Claude Code; an "Omnara: Claude & Codex Mobile" App Store listing still exists, but the repo is something else now |
| winfunc/opcode (ex-Claudia) | Last code commit 2025-10-13; the 2026-09 push only edited the README; "Release Executables Will Be Published Soon". Idea kept: a checkpoint/branching timeline for sessions |
| BloopAI/vibe-kanban | README says "Vibe Kanban is sunsetting". Idea kept: inline diff comments sent back to the agent (see D12) |
| stravu/crystal | Replaced by Nimbalyst (A7) |
| wbopan/cui, sugyan/claude-code-webui, coder/agentapi | Archived |
| JessyTsui/Claude-Code-Remote | Last push 2025-12. Email, Discord and Telegram control; lesson 10 covers the idea |
| humanlayer/humanlayer | README: "the code here is pretty much all deprecated" |
| smtg-ai/claude-squad | tmux multiplexer for desktop; no mobile or presentation lessons |
| batrachianai/toad | Terminal ACP client (AGPL); nothing needed beyond ACP itself |
| blinksh/blink | General iOS terminal (mosh), not agent-structured |
| openinterpreter/01 | Last push 2024-11; dead |
| lobehub/lobehub | Restrictive LobeHub Community License; server/web "agent operator"; the README is marketing-level, with no verifiable approval or mobile details |
| chatboxai/chatbox | The community edition is synced from a private pro repo; plain chat client; no agent or approval lessons verified |
| janhq/jan | Local-model desktop runner; outside the scope |
| HKUDS/nanobot | Server-side Python personal agent; overlaps Hermes and OpenClaw |
| TencentQQGYLab/AppAgent | Research code; last push 2025-03 |
| X-PLUG/MobileAgent | Research and model family (GUI-Owl, ToolCUA); usable as a model API, not as app code |
| simular-ai/Agent-S | Research framework that needs a separate grounding model; Python + pyautogui; heavy |
| browser-use/macOS-use, steipete/macos-automator-mcp | Archived |
| browser-use/browser-use | Python library plus cloud. Playwright MCP and agent-browser cover the lessons, and the cloud's "CAPTCHA solving" conflicts with the safety posture |
| trycua/cua | VM and sandbox fleets for computer use; heavy |
| ChromeDevTools/chrome-devtools-mcp | Web-developer debugging tool; not product-relevant |
| minitap-ai/mobile-use | Overlaps mobile-mcp and Mobilerun; not examined in depth |
| RikkaApps/Shizuku | Already used by the Android Power flavor; infrastructure with no new lessons; last push 2025-06 |
| appstefan/HighlightSwift | Last push 2024-11 |
| simonbs/Runestone | A full editor with tree-sitter grammars; too much for read-only previews (binary size) |
| langchain-ai/open-canvas | Archived |
| richardgill/llm-ui, Ephibbs/flowtoken | Stale (2025-07 and 2025-05); FlowToken has no license. Paseo and LibreChat cover smoothing (lesson 2) |
| ZohaibAhmed/clauder, maxches99/claude-client, Erscheinung/ClaudeWatch, maxonary/Chime, bistin/cc-island | Tiny or stale, or no clear license (0–30★) |
| Octane0411/open-vibe-island | GPL-3.0, 2.0k★; overlaps CodeIsland; not examined in depth |
| Shahfarzane/opencode-mobile | Last push 2026-01; A5 covers it |
| a-ghorbani/pocketpal-ai, gluonfield/enchanted | Local-model chat clients with no tool, approval or agent lessons |
| Claude Code Remote Control (Anthropic) | **Closed source** (research preview, Feb 2026). Continues a local session from claude.ai/code or the Claude iOS/Android apps. It is the baseline Claude users will compare against; LeoPhoneAgent differs by covering many CLIs, a self-hosted relay and the Watch. https://code.claude.com/docs/en/remote-control |

---

### Web sources used beyond the GitHub repos

- OpenClaw docs: https://docs.openclaw.ai/platforms/ios · https://docs.openclaw.ai/nodes · https://docs.openclaw.ai/tools/exec-approvals · https://docs.openclaw.ai/platforms/mac/canvas
- OpenCode docs: https://opencode.ai/docs/permissions/ · https://opencode.ai/docs/server/
- ACP docs: https://agentclientprotocol.com/protocol/tool-calls · https://agentclientprotocol.com/protocol/session-setup · https://agentclientprotocol.com/get-started/agents
- Paseo docs: https://paseo.sh/docs/connectivity
- OpenHands security docs: https://docs.openhands.dev/sdk/guides/security
- LibreChat docs: https://www.librechat.ai/docs/features/resumable_streams · https://www.librechat.ai/docs/features/smooth_streaming · https://www.librechat.ai/docs/features/artifacts
- Open WebUI features: https://docs.openwebui.com/features/
- AnythingLLM tool selection: https://docs.anythingllm.com/agent/intelligent-tool-selection (read through a search summary; direct fetch returned 403)
- AI SDK tool usage: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage
- AG-UI events: https://docs.ag-ui.com/concepts/events
- OpenAI Apps SDK UI guidelines: https://developers.openai.com/apps-sdk/concepts/ui-guidelines
- Claude Code Remote Control: https://code.claude.com/docs/en/remote-control
