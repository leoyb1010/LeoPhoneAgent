# Domain B — Premium Apple-platform UI/UX, iPad layouts, voice & wearables

Research for the LeoPhoneAgent upgrade plan (iPhone + iPad + Apple Watch). Date: 2026-09-25.

**Method.**
- Stars, license, and last push date come from the GitHub REST API on 2026-09-25. "Last push" is `pushed_at`.
- Code observations come from shallow sparse clones (Swift, plist, md, ts, dart) that were read directly. File names are given where useful.
- API availability was checked against Apple's documentation JSON (`developer.apple.com/tutorials/data/documentation/...`).
- Facts about iOS 27, watchOS 27 and WWDC26 come from the Apple session pages (WWDC26 269, 241, 278; WWDC25 208). The page text was machine-summarised, so API names that appear only in those summaries are marked "(per session page)".
- Anything I could not verify is marked **(unverified)**.
- Nothing was modified in any repository.

**Baseline in LeoPhoneAgent** (read-only grep of `src/ios`). These counts show where each idea would land:
- iOS 27 resizability risks: `UIScreen.main` appears 27 times and `userInterfaceIdiom` 3 times. `UIWindowScene.effectiveGeometry` is not used.
- iPad APIs: `NavigationSplitView` 6, `.inspector(` 0, `openWindow` 0, `draggable`/`onDrag` 0, `dropDestination`/`onDrop` 4.
- Info.plist has `UIApplicationSupportsMultipleScenes` = true, and `UIBackgroundModes` includes `audio`.
- Not used anywhere: `tabViewBottomAccessory`, `supplementalActivityFamilies`, `@ScaledMetric`, `contentMargins`, `performAccessibilityAudit`.
- Already used: `UIHostingConfiguration` 29 times, so SwiftUI rows are already hosted in UIKit lists. `BGContinuedProcessing*` 5 times. `accessibilityReduceMotion` 31 times.
- `LeoWatch/`:
  - Input uses `TextFieldLink` and `handGestureShortcut`.
  - The direct client sends `stream: false` with `max_tokens` 600.
  - Approvals go through `WCSession.sendMessage` and fail when the phone is not reachable.
  - `WatchMotionViews.swift` has three `repeatForever` animations and never checks `isLuminanceReduced`.
- Inherited from upstream OpenMinis: an in-house terminal emulator (`iSH/Terminal`), swift-cmark Markdown, and `TextFadeAnimator` (a word-by-word fade driven by one CADisplayLink). The ideas below do not duplicate these.

---

## 1. Kept projects

| # | Project | URL | License | Stars | Last push | Why it matters |
|---|---|---|---|---|---|---|
| 1 | Ice Cubes | https://github.com/Dimillian/IceCubesApp | AGPL-3.0 | ~7.1k | 2026-09-20 | Best open SwiftUI reference for Liquid Glass adoption, a `sidebarAdaptable` iPad shell, and multi-window |
| 2 | NetNewsWire | https://github.com/Ranchero-Software/NetNewsWire | MIT | ~10.4k | 2026-09-23 | Performance-first culture; 3-column iPad split; context-scoped key commands; cached text measurement |
| 3 | Element X iOS | https://github.com/element-hq/element-x-ios | AGPL-3.0 | ~0.9k | 2026-09-25 | SwiftUI chat rows on a flipped UITableView; updates deferred while dragging; generated a11y audits |
| 4 | Signal-iOS | https://github.com/signalapp/Signal-iOS | AGPL-3.0 | ~12.2k | 2026-09-23 | Render state and cell measurement built off the main thread for very long chats |
| 5 | Telegram-iOS | https://github.com/TelegramMessenger/Telegram-iOS | none detected (unverified) | ~9.0k | 2026-09-14 | Motion benchmark: serialized list transactions, one spring "transition" object passed through layout |
| 6 | Wikipedia iOS | https://github.com/wikimedia/wikipedia-ios | MIT | ~3.4k | 2026-09-24 | Font tokens built on Dynamic Type, serif display type, `glassEffectID` morphs |
| 7 | FlowDown + ListViewKit + MarkdownView (Lakr233) | https://github.com/Lakr233/FlowDown | AGPL-3.0 (libs MIT) | ~1.2k / 89 / 154 | 2026-09-07 / 09-24 / 09-09 | Fastest native streaming chat list and streaming Markdown (UIKit) in this set |
| 8 | Textual | https://github.com/gonzalezreal/textual | MIT | ~0.9k | 2026-06-15 | Successor to MarkdownUI; renders through SwiftUI `Text`; supports watchOS 11 |
| 9 | MarkdownView (LiYanan2004) | https://github.com/LiYanan2004/MarkdownView | MIT | ~0.8k | 2026-08-12 | SwiftUI streaming-Markdown reader API |
| 10 | exyte/Chat | https://github.com/exyte/Chat | MIT | ~1.9k | 2026-09-22 | Inverted table, actor update queue, diffs applied in phases |
| 11 | Agmente | https://github.com/rebornix/Agmente | MIT | ~0.5k | 2026-05-31 | Agent-transcript row types on ListViewKit with height and Markdown caches |
| 12 | fullmoon | https://github.com/mainframecomputer/fullmoon-ios | MIT | ~2.3k | 2025-05-05 (stale) | Minimal, premium local-LLM chat: throttled streaming, scroll interruption, "thought for Xs" |
| 13 | Enchanted | https://github.com/gluonfield/enchanted | Apache-2.0 | ~6.0k | 2026-07-07 | 100 ms buffered flush, live dictation into the composer, TTS voice picker |
| 14 | hermex | https://github.com/uzairansaruzi/hermex | MIT | ~1.4k | 2026-09-25 | Codified scroll-follow latch, motion and haptic tokens, agent-run Live Activity |
| 15 | Happy | https://github.com/slopus/happy | MIT | ~23.9k | 2026-09-22 | Remote Claude Code/Codex approval UX and voice-agent guardrails (React Native) |
| 16 | PhoneClaw | https://github.com/kellyvv/PhoneClaw | Apache-2.0 | ~1.3k | 2026-08-06 | Voice quick-ask from the Dynamic Island; uses `BGContinuedProcessingTask` |
| 17 | mimi-remote | https://github.com/gaixianggeng/mimi-remote | GPL-3.0 + store exception | ~0.1k | 2026-09-25 | iPhone/iPad agent workbench: split vs push routing, inspector, keyboard and pointer polish |
| 18 | CodeEdit | https://github.com/CodeEditApp/CodeEdit | MIT | ~23.0k | 2026-08-18 | Command palette, activity viewer, inspector areas (macOS) |
| 19 | Code App | https://github.com/thebaselab/codeapp | MIT | ~4.0k | 2026-09-15 | iPad IDE shell: resizable sidebar and bottom panel, tabs, keyboard toolbar |
| 20 | a-Shell | https://github.com/holzschu/a-shell | BSD-3-Clause | ~3.9k | 2026-09-23 | Separate context per window; Shortcuts run headless |
| 21 | Blink Shell | https://github.com/blinksh/blink | GPL-3.0 | ~7.0k | 2026-06-29 | Keyboard-first iPad terminal, smart keys, fuzzy snippets |
| 22 | SwiftTerm | https://github.com/migueldeicaza/SwiftTerm | MIT | ~1.7k | 2026-09-23 | Native terminal engine and view (CoreText, optional Metal) |
| 23 | Runestone | https://github.com/simonbs/Runestone | MIT | ~3.2k | 2026-03-25 | Fast native code/text view built on tree-sitter |
| 24 | Pulse | https://github.com/kean/Pulse | MIT | ~7.2k | 2026-08-15 | Windowing for a live-updating SwiftUI list; one codebase that includes watchOS |
| 25 | Conduck | https://github.com/GigaDuckAI/conduck | Apache-2.0 | 30 | 2026-09-23 | Closest match to "your own AI, voice-first, every Apple device incl. Watch"; decisions are documented |
| 26 | Home Assistant iOS | https://github.com/home-assistant/iOS | Apache-2.0 | ~2.4k | 2026-09-25 | Mature watch voice assistant, controls, small Live Activity family, watch notification quirks |
| 27 | Pinch (apple-watch-claude-code) | https://github.com/JoshKappler/apple-watch-claude-code | none | 6 | 2026-08-27 | Claude Code approvals on the watch; lesson learned on crown vs tap |
| 28 | watchGPT | https://github.com/TheMarco/watchGPT | PolyForm-Noncommercial-1.0.0 | 7 | 2026-08-24 | Voice-first watch UI, animations that respect Always On, iPhone relay design |
| 29 | ETOS LLM Studio | https://github.com/Eric-Terminal/ETOS-LLM-Studio | GPL-3.0 | ~0.2k | 2026-09-25 | Sibling iOS + watch agent app; shows watch input realities and the cost of breadth |
| 30 | Loop | https://github.com/LoopKit/Loop | MIT (with exceptions) | ~1.7k | 2026-09-24 | "Turn the Digital Crown to confirm" for high-stakes actions |
| 31 | Pocket Casts iOS | https://github.com/Automattic/pocket-casts-ios | MPL-2.0 | ~1.8k | 2026-09-25 | Watch model with a "phone vs watch" source switch for standalone use |
| 32 | omi | https://github.com/BasedHardware/omi | MIT | ~13.6k | 2026-09-25 | Battery-aware watch recorder; one shared vocabulary of capture states |
| 33 | WhisperKit (argmax-oss-swift) | https://github.com/argmaxinc/argmax-oss-swift | MIT | ~6.4k | 2026-09-24 | Shows interim vs confirmed transcript; cost reference for on-device STT |
| 34 | LiveKit agent starter + components | https://github.com/livekit-examples/agent-starter-swift | MIT (components Apache-2.0) | 96 / 44 | 2026-09-14 / 04-10 | Visual language for agent states; transcript layout |
| 35 | Pipecat (+ iOS client) | https://github.com/pipecat-ai/pipecat | BSD-2-Clause | ~15.8k (iOS client 26) | 2026-09-25 | Event vocabulary for voice UI states (interim/final transcript, bot speaking) |
| 36 | Pow | https://github.com/EmergeTools/Pow | MIT | ~4.4k | 2026-04-13 | Catalogue of change effects (reference only) |
| 37 | open-swiftui-animations | https://github.com/amosgyamfi/open-swiftui-animations | Unlicense | ~5.7k | 2026-08-14 | Animation recipes that use only native SwiftUI, including glass morphing |
| 38 | SwiftUI-Shimmer | https://github.com/markiv/SwiftUI-Shimmer | MIT | ~1.7k | 2024-08-14 (stable) | Tiny shimmer pattern for "thinking" labels |

---

## 2. Project notes

### A. iPhone chat and overall polish

#### 1. Ice Cubes
- Platforms: iOS, iPadOS, macOS (Catalyst), visionOS. Built entirely in SwiftUI.
- Split into SwiftPM feature packages (Timeline, StatusKit, DesignSystem, Env, MediaUI…). `AGENTS.MD` says new features must not use ViewModels and should use `@Observable` services injected through `Environment`.
- Navigation: one `TabView(.sidebarAdaptable)`.
  - `TabSection`s marked `.tabPlacement(.sidebarOnly)` hold the iPad/Mac-only sections.
  - On iOS 27 it applies `.defaultTabBarPlacement(horizontalSizeClass == .regular ? .sidebar : .automatic)`.
  - An optional secondary notifications column appears on iPad, controlled by a user setting (`AppView.swift`).
- Liquid Glass, gated to iOS 26 with material fallbacks:
  - The DM composer is a `GlassEffectContainer` holding a `.buttonStyle(.glass)` attach button, a `.glassProminent` send button, and a field with `.glassEffect(.regular.interactive(), in: .rect(cornerRadius: 18))`.
  - The "new posts" pill is a tinted, interactive glass capsule.
  - `ToolbarSpacer` separates toolbar groups.
- Scroll edges: the timeline uses `.safeAreaBar(edge: .top)` for pinned filter pills plus `.scrollEdgeEffectStyle(.soft, for: .top)`. This replaces the old `Material.ultraThin` bar.
- Lists:
  - The timeline is a SwiftUI `List(.plain)` inside a `ScrollViewReader`, with `defaultMinListRowHeight` 1.
  - Tapping the already-selected tab scrolls to the top.
  - The DM thread is a `ScrollView + LazyVStack` with a bottom anchor, `.scrollDismissesKeyboard(.interactively)`, and the composer in `.safeAreaInset(edge: .bottom)`.
- Typography: every font goes through `Font.scaledBody` and friends, which is `UIFontMetrics` scaling × a user font-size multiplier, with an optional custom or rounded font. Sizes are bumped on Mac.
- Feel:
  - `HapticManager` keeps its generators `prepare()`d, and `SoundEffectManager` plays sounds on tab selection.
  - The media viewer uses `.navigationTransition(.zoom(sourceID:in:))`, `.presentationSizing(.page)` and `presentationCornerRadius(16)`.
- Windows:
  - `WindowGroup(for: WindowDestinationEditor.self)` and `WindowGroup(for: WindowDestinationMedia.self)` open the composer and media viewer as separate windows, with `.windowResizability(.contentMinSize)`.
  - `CommandMenu`/`CommandGroup` provide ⌘R, ⌘N and similar.
  - Rows and media are `.draggable`, the editor accepts `.onDrop`, and rows use `.hoverEffect`.
- App Intents: `AppShortcutsProvider` plus Post, InlinePost (acts without opening the app), PostImage and Tab intents. Widgets live in an extension.
- Weight: many dependencies (Nuke, EmojiText, Gifu, KeychainSwift, TelemetryDeck, SwiftSoup, LRUCache, swiftui-introspect, Bodega, RevenueCat, ButtonKit, WrappingHStack). The premium feel comes from system components, restrained custom glass, and haptics.

#### 2. NetNewsWire
- Platforms: iOS/iPadOS (UIKit) and macOS (AppKit).
- `Technotes/CodingGuidelines.md` ranks values as: no data loss, then no crashes, then no bugs, then fast performance, then developer productivity. All classes are `final` and objects stay small.
- iPad: a three-column `UISplitViewController` with `preferredSplitBehavior = .tile`.
  - The preferred display mode is persisted.
  - Programmatic `showColumn` is suppressed so it does not break state restoration.
  - The iOS Info.plist sets `UIApplicationSupportsMultipleScenes` to false.
- Keyboard: `KeyboardManager` builds `UIKeyCommand`s per context from plists (global / sidebar / timeline / detail).
  - It sets `wantsPriorityOverSystemBehavior = true`.
  - It returns no commands while a text field is first responder.
- Timeline performance:
  - Uses `UICollectionViewDiffableDataSource<Int, Article>` with cells laid out manually.
  - `MultilineUILabelSizer` caches heights per (font, line count), then per string and width, to "avoid actually measuring text as much as possible".
- Liquid Glass (v7): the App Store copy says "Now with Liquid Glass!".
  - Uses iOS 26 `navigationItem.subtitleView`.
  - Rows get a rounded, inset selection background (20 pt) only when the split view is expanded.
  - The code contains several workarounds for iOS 26 `UINavigationBar` crashes.
- Widgets read a small JSON snapshot in the App Group, never the database. It is written on background refresh and when the scene goes to the background. Tapping a widget deep-links via `nnw://` (`Technotes/Widgets.md`).
- `Technotes/Accessibility.md` goals: full keyboard navigation, don't override system shortcuts, test with VoiceOver and Dictation.

#### 3. Element X iOS
- SwiftUI app on matrix-rust-sdk. Licensed AGPL-3.0 or commercial.
- The timeline is a UIKit `UITableView` flipped with `scaleY: -1`. SwiftUI rows are hosted through `UIHostingConfiguration`, and each content view is flipped back. It uses a diffable data source keyed by item ID.
- Updates are deferred while the user interacts:
  - When the timeline is live, new items wait (`hasPendingItems`) while the user drags.
  - When it is not live, they wait while the list scrolls.
  - They are applied once the gesture ends, so nothing jumps under the finger (`TimelineTableViewController.swift`).
- Also has a floating date badge, a typing-indicator cell, read-marker tracking, and pagination through a publisher.
- Composer (`ComposerToolbar.swift`):
  - The send button swaps for a voice-message record button when the field is empty.
  - A WYSIWYG rich-text mode expands into a formatting bar.
  - `.keyboardShortcut(.return, modifiers: [.command])` sends.
  - An inline "not encrypted" label and a mention-suggestion overlay sit above the field.
- Voice-message UI: a live waveform (DSWaveformImage) with `@ScaledMetric` line widths, a `.monospacedDigit()` timer, and a pulsing record badge.
- Design system "Compound" (`compound-ios/`): font, colour and icon tokens. `Compound.supportsGlass` (true on iOS 26) switches icon sizes and paddings.
- Accessibility: an `AccessibilityTests` target is generated with Sourcery and calls `performAccessibilityAudit(named:)` for every SwiftUI preview.

#### 4. Signal-iOS
- UIKit.
- `CVLoader` builds a complete render state on a background queue inside one database read transaction, then emits `CVUpdate` diffs. It uses a `userInteractive` queue for the first load and `userInitiated` afterwards (`CVUtils.workQueue`).
- `CVCellMeasurement` (cell size plus subview layout) is computed off the main thread for every item. Cells only apply the precomputed layout, through a custom `ConversationViewLayout`.
- The first load count comes from screen height ÷ ~35 pt (average message height), so one fetch fills the viewport (`MessageLoader.swift`).
- Includes voice-memo recording in the input toolbar and a scroll-to-bottom button (`ConversationScrollButton`).
- Weight: a large bespoke framework. Borrow the principles (off-main measurement, coherent snapshots), not the code (AGPL and size).

#### 5. Telegram-iOS
- Its own UI stack (`submodules/Display`: `ListView`, node-based rendering). Builds only with Bazel. The repo is about 849 MB.
- License: no LICENSE file at the root. The README only says "comply with the licences" (unverified).
- `ListViewTransactionQueue` serializes list mutations so one animated change finishes before the next starts.
- `ContainedViewLayoutTransition` is `.immediate` or `.animated(duration:curve:)`, with `.spring` or `.customSpring(mass:stiffness:damping:initialVelocity:)`. The same transition object is passed through every layout call.
- `DisplayLinkAnimator` and `Spring.swift` drive animations frame by frame.
- Take the ideas (serialized list transactions, one transition per layout pass), not the architecture.

#### 6. Wikipedia iOS
- UIKit plus a SwiftUI component package (`WMFComponents`).
- `WMFFont` has about 60 styles, all derived from `preferredFont(forTextStyle:)` plus `UIFontMetrics.scaledFont`, so Dynamic Type works everywhere. Reading contexts use Georgia serif titles.
- Tokens: `WMFColor`, `WMFSpacing`, `WMFCornerRadius`, `WMFTheme`.
- Liquid Glass:
  - Toasts and the find-in-page bar use `.glassEffect`.
  - The prev/next buttons morph with `.glassEffectID(_:in:)`.
  - The UIKit progress HUD uses `UIGlassEffect`.
- Tabs use `UITab` (iOS 18) with `preferredPlacement = .fixed`, which keeps a tab bar on iPad. This is a typography reference, not an iPad-layout one.

### B. Markdown and list engines

#### 7. FlowDown, ListViewKit, MarkdownView (Lakr233)
- FlowDown: a Swift + UIKit AI chat client for iPhone, iPad and Mac.
  - Connects to OpenAI-compatible providers, runs MLX models locally, syncs through iCloud, and supports Shortcuts and Live Activity.
  - Its chat UI is extracted as LanguageModelChatUI (MIT).
- ListViewKit:
  - Rows are measured only when needed. The rest is corrected in slices between frames.
  - `append` is O(log n), and `update` rewrites a streaming message.
  - Its README says height closures are "one to two orders of magnitude" cheaper than self-sizing.
  - Follow pattern from the README:
    ```swift
    let shouldFollow = list.isScrolledToBottom(tolerance: 4)
    list.append(message)
    if shouldFollow, !list.isUserInteractingWithScroll {
        list.scrollToBottom(animated: false)
    }
    ```
    `isUserInteractingWithScroll` counts momentum scrolling.
- MarkdownView (Lakr233):
  - Pure UIKit/AppKit and built for streaming: updates are throttled and views reused, so calling it on every token is fine.
  - Deliberately not full CommonMark.
  - Tables and code blocks are pulled out of lists so they read well on a phone.
  - Code highlighting runs asynchronously through Highlightr, which uses JavaScriptCore. Math uses SwiftMath.
  - A `WatchMarkdownView` product supports watchOS 8+.
- Dependencies (weight): MarkdownView needs Litext, SwiftMath, swift-collections, Highlightr, swift-cmark and LRUCache. ListViewKit needs MSDisplayLink.
- Licenses: MarkdownView's LICENSE file is MIT, but GitHub reports NOASSERTION.
- The FlowDown README says Live Activity keeps streaming in the background "with sound effects enabled". That looks like a background-audio keep-alive; exact mechanism unverified. Treat it as an App Review and battery risk.

#### 8–9. Streaming Markdown renderers: Textual; MarkdownView (LiYanan2004)
- **Textual** (the successor to MarkdownUI; MarkdownUI's repo now says "maintenance mode"):
  - Keeps SwiftUI's `Text` rendering pipeline. `InlineText` is a drop-in for `Text`; `StructuredText` handles block content.
  - Parses with Foundation's `AttributedString` Markdown parser (`PresentationIntent`). A pluggable `MarkupParser` protocol allows other formats.
  - Native text selection on iOS, macOS and visionOS. Measurements are font-relative, so they scale with Dynamic Type.
  - Platforms: iOS 18, macOS 15, tvOS 18, watchOS 11, visionOS 2.
  - Code highlighting uses Prism through `JSContext` (`CodeTokenizer.swift`), which is heavier than it looks.
- **MarkdownView (LiYanan2004)**:
  - Built on swift-markdown (CommonMark).
  - For streaming, create one `StreamingMarkdownSource` per response and render it with `StreamingMarkdownReader`. Update `.text` as chunks arrive and call `finishStreaming()` at the end.
  - Continuous text selection is available on iOS and macOS through RichText.
  - Dependencies: Highlightr, SwiftMath, RichText. Supports watchOS 9+.

#### 10. exyte/Chat
- A SwiftUI chat UI library for iOS 17+.
- A `UITableView` rotated 180° hosts SwiftUI cell content.
- An `actor UpdateQueue` serializes table transactions.
- Diffs are split into phases (deletes, then swaps and edits, then inserts) in `UIList+OperationsSplit.swift` to avoid table inconsistency crashes and wrong animations.
- Features: long-press menu with reply/edit/delete, media picker, audio messages, link previews, stickers, live location.
- Dependencies: MediaPicker, the Giphy SDK, Kingfisher and AnchoredPopup. Too heavy to adopt as a library; learn the phased updates.

#### 11. Agmente
- iOS client for ACP and Codex app-server agents.
- `HighPerformanceChatListView` is UIKit, built on ListViewKit, with row types: user text, user images, assistant markdown, assistant thought, assistant plan, tool call, file changes, system, error, streaming.
- Supporting pieces: `ChatHeightCache`, `ChatMarkdownPackageCache` (Markdown parsed ahead of time), `ChatRenderDiff`, and a render queue at `.userInteractive`.
- Tool-call rows carry approve/deny colours, and `ChatComponentGalleryView` shows every row type in a debug gallery.

#### 12. fullmoon
- SwiftUI chat app for iPhone, iPad, Mac and visionOS, running MLX models. No pushes since 2025-05.
- Streaming updates the UI only every 4 tokens (`displayEveryNTokens = 4` in `LLMEvaluator`).
- Scrolling:
  - `.defaultScrollAnchor(.bottom)` plus `.scrollPosition(id:anchor:)`.
  - Auto-scroll stops once the user scrolls during generation (`scrollInterrupted`).
- Reasoning shows as a collapsible "thinking… (Ns)" / "thought for Ns" block with a capsule rule beside it.
- Composer: one rounded field with a 48 pt minimum height. Send turns into stop while running. The model picker is a chevron-up circle button. All copy is lower-case.
- `RequestLLMIntent` (Siri/Shortcuts) has a "continuous" mode that caps voice replies at 4 sentences and 300 characters.
- Plays a haptic on every streamed output change. This is the thing to avoid (see iPhone idea 6).

#### 13. Enchanted
- Ollama client for iOS, macOS and visionOS. The README names Jaz (a Go client/server) as its successor.
- Tokens accumulate in a buffer that `Throttler(delay: 0.1)` flushes to the message (`ConversationStore.handleReceive`).
- While generating, a `RunningBorder` draws a rotating angular-gradient stroke.
- Dictation (`RecordingView`) streams partial transcripts into the composer.
- TTS uses `AVSpeechSynthesizer` with a voice picker.
- On macOS there is a floating completion panel (`PromptPanel`) and hotkeys.
- `VoiceView` is an unfinished stub, so there is no dedicated voice mode.

### C. Agent and remote-control clients

#### 14. hermex
- Native SwiftUI iPhone app (iOS 18+) for a self-hosted Hermes agent.
- `ChatScrollPolicy` (auto-follow):
  - Following is an explicit on/off latch, not a distance test.
  - It turns off when a drag starts or a gesture moves the offset.
  - It turns back on after a send, a tap on scroll-to-bottom, or a gesture that settles within 12 pt of the bottom.
  - Growth from streamed tokens never flips it.
  - The scroll-to-bottom button stays hidden within 80 pt of the bottom when idle, or 160 pt while streaming. A finished drag waits 0.16 s for momentum before counting as settled.
- `ChatMotion` holds every animation curve in one enum:
  - Reduce Motion returns `nil` (snap), never "a shorter ease".
  - Streaming follow uses `.easeOut(0.15)`, retargeted on each flush of the ~48 ms word reveal.
  - New user rows fade in and rise 8 pt; new assistant rows only fade. Removal is instant.
- `ChatHaptics` maps events to feedback: sent → light, completed → success, cancelled → medium, deny → warning, enabling bypass → warning.
- `ApprovalRequestOverlay` is a modal card (max width 520) showing the pending count. Choices are once / session / always / deny, plus "skip all".
- Live Activity (`AgentRunActivityAttributes`):
  - The status is derived from the tool kind: thinking, running command, searching files, reading files, using tool, waiting, complete.
  - "chips" carry counts only, commented as "never reply text, so it is safe on a locked phone".
  - Has a stale flag and uses `Text(timerInterval:)` for elapsed time.
- Also: a context-window ring (30 pt ring inside a 44 pt target) with a popover, and an active-run status capsule that allows 2 lines at accessibility text sizes.
- Wide layouts: `adaptiveReadableScrollContent(maxWidth:)` calls `contentMargins(.horizontal, max((width - maxWidth)/2, 0), for: .scrollContent)`. Widths used: 800 and 1000. Sheets use `.presentationSizing(.form/.page)`.

#### 15. Happy
- Built with Expo/React Native for iOS, Android and web, plus a macOS desktop app. Remote-controls Claude Code and Codex end-to-end encrypted, with push notifications for permission requests and errors.
- `PermissionFooter` under each tool card offers:
  - Yes
  - Yes for session (adds a `Bash(cmd)`-style pattern to the allow list)
  - Allow all edits
  - Bypass
  - No / "Stop and explain" (Codex abort)

  After the decision, the chosen button stays highlighted, and each button has its own loading state.
- Each tool has its own renderer: Bash, Edit/MultiEdit diff, Write, Todo, Task, ExitPlan, AskUserQuestion, MCP.
- The realtime voice layer (ElevenLabs) prompt says to:
  - answer in one sentence,
  - call `skip_turn` when the user is talking to someone else,
  - never approve or deny on its own,
  - report when the agent finishes.
  The voice context gets tool names only (no arguments) and the last 50 messages.

#### 16. PhoneClaw
- On-device agent runtime (LiteRT Gemma, MiniCPM-V) with native Skills and an optional Mac gateway.
- "LiveLand":
  - Launched from Home Screen or Lock Screen widgets, Control Center or Shortcuts. The intent sets `openAppWhenRun = true`.
  - Voice capture uses VAD.
  - The Dynamic Island steps through phases: understanding, querying, executing, summarizing, result. A skill prompt stays on screen at least 0.8 s.
- Uses iOS 26 `BGContinuedProcessingTask` to finish a run after the user leaves the app. It checks `BGTaskScheduler.supportedResources.contains(.gpu)` first.
- Asks for confirmation when times or contacts are ambiguous, and before deletes and bulk operations.

### D. iPad-first references

#### 17. mimi-remote
- Native SwiftUI iPhone + iPad client for Codex and Claude Code, with a Go `agentd` on the host.
- License: GPL-3.0 plus an App Store / Google Play exception. It is compatible with LeoPhoneAgent's GPLv3.
- One route model for both devices (`UnifiedWorkbenchShell`):
  - Regular width uses `NavigationSplitView`, with sidebar widths min 260 / ideal 300 / max 340.
  - Compact width uses real push navigation, because a collapsed split view's detail column has no back stack and so no edge-swipe back.
- `.inspector(isPresented:)` shows session context, a diff panel or a related sub-agent conversation when the layout allows. Otherwise a floating sidebar is used, with its visibility stored in `@SceneStorage`.
- Keyboard: ⌘Return sends, ⌃⌘S toggles the sidebar, ⌘⇧D is also bound. In the composer, ↑/↓/Return/Tab/Esc `UIKeyCommand`s drive skill autocomplete.
- Pointer: rows use `.hoverEffect(.highlight)`. `MimiPressButtonStyle` scales to 0.985 at 0.84 opacity. Precedence is pressed > focused > hovered, with no custom hover state.
- With Reduce Motion, the same state changes happen without spatial effects. Reduce Transparency is read as well.

#### 18. CodeEdit (macOS)
- Areas: NavigatorArea, Editor, InspectorArea, UtilityArea (a terminal through SwiftTerm), StatusBar, and an ActivityViewer.
- The ActivityViewer shows running tasks and notifications in the toolbar with a circular progress view.
- Command palette (`QuickActionsViewModel`):
  - Filters `CommandManager.shared.commands` by case-insensitive "contains" and selects the first result.
  - Bolds the matched part of each result.
  - Open Quickly uses fuzzy search.

#### 19. Code App
- An iPad IDE modelled on VS Code:
  - An ActivityBar plus a sidebar that resizes by dragging (`RegularSidebar`), or `CompactSidebar` when narrow.
  - `EditorTabs` can be dragged.
  - A bottom `PanelView` holds the terminal and resizes by dragging.
  - `EditorKeyboardToolBar`, and user-customisable keyboard shortcuts.
- Weight: Monaco in a WKWebView, plus local Python, Clang, Node, PHP and Java runtimes. Heavy by design.

#### 20. a-Shell
- iOS/iPadOS 14+. Each window has its own context, appearance, history and working directory (`newWindow`, `exit`).
- Shortcuts actions run either "In Extension" (headless, lightweight) or "In App".
- The terminal is hterm in a WKWebView, with an input assistant bar and key commands.

#### 21. Blink Shell
- A full-screen terminal with no menus.
- Gestures: two-finger tap opens a shell, swipe switches shells, slide down closes, pinch zooms.
- Hardware keyboard remapping (Caps as Ctrl or Esc) and a custom accessory bar (`SmarterKeys`/`KBView`).
- Snippets with fuzzy search (`BlinkSnippets/fuzzy.swift`), from local, iCloud or GitHub sources.
- Mosh keeps connections alive on mobile networks.

#### 22. SwiftTerm
- A UI-agnostic VT100/xterm engine with UIKit and AppKit views, plus a headless mode.
- Rendering uses CoreText, with optional Metal GPU rendering.
- Supports Unicode and emoji, bidirectional text, selection and search, hyperlinks, and Sixel / iTerm2 / Kitty images. Terminal instances are thread-safe.
- Used by La Terminal, Secure ShellFish and CodeEdit.

#### 23. Runestone
- Built on tree-sitter incremental parsing with AvalonEdit-style line management.
- Line numbers, invisible characters, page guide, regex search.
- Its README says to judge performance only in Release builds.

#### 24. Pulse
- SwiftUI on iOS 15, tvOS 15, watchOS 8, macOS 12 and visionOS 1. The code has 67 `#if os(watchOS)` branches.
- The console list:
  - Renders a growing prefix of Core Data results (`fetchBatchSize` 100; the window grows by 100 as the user nears the end).
  - Tracks which cells are visible with `onAppear`/`onDisappear`.
  - Applies live inserts only when the user is near the top. In the middle it skips them: "Don't reload: too expensive and ruins gestures".
  - Skips refreshes entirely while the view is hidden.

### E. Apple Watch

#### 25. Conduck
- Covers iPhone, iPad, Mac, Apple Watch and CarPlay. Requires iOS, iPadOS, macOS and watchOS 26.5.
- Users bring their own AI (OpenRouter, Ollama, LM Studio, OpenAI-compatible, or agent gateways). There is no Conduck server.
- `docs/ai-context/spec.md` records each decision along with the alternatives it rejected.
- Streaming (spec): replies are deliberately not streamed. Each turn rides a background URLSession upload task that survives suspension, which is what lets Watch, Action Button and CarPlay turns complete.
- Conversation list states (spec):
  - Rows show working, answered-but-unseen, or failed. Delivery and attention are tracked separately.
  - Stop appears only when this device can actually cancel the turn.
  - Several agents answering at once play "one chime per burst".
  - Opening a thread clears both its reply and failure banners.
- Speech (spec): Apple on-device STT/TTS by default, cloud optional. If cloud TTS fails, the Apple voice fills in and the substitution is announced. Each platform has one speak engine with exactly-once completion.
- Watch networking:
  - The watch records locally. It hands the clip to the phone only when transcription is on-device or a custom endpoint. The gateway hop always goes directly from the wrist.
  - Requests run in the foreground (source comment: "a 2-minute frontmost window"). On error they fall back to a `URLSessionConfiguration.background` session with `allowsCellularAccess = true`.
  - WatchConnectivity: `sendMessage` when reachable, `transferUserInfo` for queued delivery, `updateApplicationContext` for latest state. File descriptions go out on both channels and are de-duplicated by turn ID.
- Watch thread:
  - Plain-text bubbles only, no Markdown on the watch.
  - Tap a bubble to hear it. Text first goes through `ReplySanitizer.spoken`, which strips Markdown, code fences, URLs, emoji, and control/bidi characters.
  - Auto-speak only while active, or on wrist raise within a freshness window; otherwise the reply stays a notification ("no jump-scare").
  - TTS pauses on wrist-down or dim and resumes on raise. Starting the mic stops TTS.
- Watch audio session (source comments):
  - Activates asynchronously (`activate(options:completionHandler:)`), and writes the category off the main thread.
  - On finish it deactivates with `.notifyOthersOnDeactivation` after a grace period, so ducked music comes back.
  - Apple voice is "locked to .default" on watchOS, with no enhanced, premium or Personal Voice tier (unverified against Apple docs).
- Watch scrolling: scroll-to-bottom snaps without animation, then re-snaps for up to ~225 ms until the height settles. The comment says animated `scrollTo` stutters on watchOS.
- Network errors: a `-1009` shows hedged copy ("If your iPhone is nearby, your watch may be using its connection…"). The source says there is no API to force the watch's own Wi-Fi or cellular; that is their claim, citing TN3135.
- Composer and controls:
  - One Button with one Image morphs mic → send → stop through `.contentTransition(.symbolEffect(.replace))`. The comment explains the identity must stay stable, or the swap snaps.
  - On the watch, a `TextField` clipped to a 36 pt pill is used as the launcher for system scribble, dictation and keyboard.
  - A watch `ControlWidget` records from Control Center, the Smart Stack or the Action Button. A watch `AppShortcutsProvider` makes the system index the intent at install time.

#### 26. Home Assistant iOS
- Platforms: iOS, iPadOS, macOS (Catalyst), watchOS, CarPlay.
- Watch Assist screen:
  - The whole screen is one button, and `.handGestureShortcut(.primaryAction)` (watchOS 11) starts talking.
  - `WKInterfaceDevice.play(.start)` fires when recording starts and when it starts waiting.
  - An orb driven by audio level (drawn in a `TimelineView`) is built only while recording, so it isn't redrawn every frame the rest of the time.
  - On watchOS 26 the loading spinner sits on a `.glassEffect(.clear, in: .circle)`.
  - The chat uses `LazyVStack`, avoiding `List`'s minimum row height.
  - A red `iphone.slash` shows when the phone isn't reachable.
- Latency: sends a "wakeup" message to the iPhone before recording starts, then runs a 1 s ping loop while waiting.
- Keeps running with `WKExtendedRuntimeSession` under `WKBackgroundModes = self-care`, with reference-counted holders. This is an App Review risk for an app that is not really self-care.
- Live Activities:
  - Push-to-start registry, with push tokens given a 12 h TTL to match the Dynamic Island cap.
  - Updates sent with an alert "ping a paired Apple Watch".
  - An iOS 18 configuration adds `.supplementalActivityFamilies([.small])` for the Smart Stack.
- Watch notification quirk (`NotificationActionSplit`): watchOS never returns a `UNTextInputNotificationResponse` for a notification forwarded from the iPhone, so HA presents text-input actions itself. Actions marked `.authenticationRequired` stay with the system.
- Also: iOS 18 controls (ControlAssist, ControlLight…), watch complications fed from a snapshot store, and an in-app toast in its own non-interactive overlay window (`DynamicIslandToast`).

#### 27. Pinch (apple-watch-claude-code)
- Watch and iPhone apps in SwiftUI, with a Node backend on the Mac wrapping the Claude Agent SDK. No license.
- Transport: plain HTTP request/response plus a 1.2 s poll. The README says "watchOS refuses WebSockets on the watch's cellular path". The backend is reached through an ngrok static domain with a bearer token.
- `PermissionCardView`:
  - Docks as a non-blocking bottom bar with a risk-coloured title.
  - Shows the diff or command in a monospace area capped at 64 pt that scrolls with a finger.
  - High-risk requests hide "Remember this session" and tint Allow orange.
- The decision is tap-only. The code comment says crown-driven allow/deny used to cause accidental decisions while the user was crown-scrolling the chat. The README still describes the crown flow; the code has replaced it.
- Hardware double tap (`handGestureShortcut(.primaryAction)`) sends. A wrist shake cancels a running turn. Replies are read over AirPods with a haptic, and a `.notification` haptic fires when a permission is needed.
- A browser simulator speaks the same protocol, so the loop can be tested without hardware.

#### 28. watchGPT
- PolyForm Noncommercial license, so not GPL-compatible: patterns only.
- Architecture: watch → WatchConnectivity → iPhone → WebSocket → OpenAI. The README says the watch "cannot reliably open arbitrary outbound WebSockets": `URLSessionWebSocketTask`, `waitsForConnectivity` and `NWConnection` all failed in testing.
- Two modes: Fast (realtime speech-to-speech) and Think (STT → Responses API → TTS).
- UI: a rounded-square voice button, a glow coloured by phase, a halo that reacts to audio, and an iPhone reachability pill.
- In Always On it switches to grayscale, and the `TimelineView` pauses whenever the app is inactive, luminance is reduced, or Reduce Motion is on.
- Sessions end after 30 s of silence. The API key never reaches the watch.
- Uses "workout runtime" to stay alive (App Review risk).
- `Shared/LiquidGlass.swift` puts all the gated glass calls and their fallbacks in one helper.

#### 29. ETOS LLM Studio
- iOS + watchOS, about 362k lines of Swift according to the README.
- Features: bring-your-own providers, local GGUF models, a local Linux (ish-multiarch) that covers iOS and watchOS, a browser agent, MCP, and Live Activities.
- Watch input:
  - Uses `TextFieldLink`. A comment notes it has no way to pre-fill text, so editing a draft needs a separate page.
  - Voice is recorded with `AVAudioRecorder`, then sent to an STT model or passed to the model as audio.
- The watch also has Digital Crown image zoom, bubble action bars that can be reordered, and slash commands.
- Watch settings include worldbooks, regex rules, request-body sliders and more. This is the counterexample on breadth.

#### 30. Loop
- Watch bolus confirmation screen:
  - Reads "Turn Digital Crown to bolus".
  - `digitalCrownRotation` runs over −1…1 with `sensitivity: .low` and `scalingRotationBy: 4`, so about a quarter turn completes it. Either direction counts.
  - Progress resets to 0 every 0.25 s unless the crown keeps turning.
  - `WKInterfaceDevice.play(.success)` fires on completion.

#### 31. Pocket Casts iOS
- Watch home switches between a "Phone" and a "Watch" source.
  - The choice is persisted, and each source shows different rows.
  - Titles carry a source glyph.
- In standalone mode the watch syncs with the server and downloads episodes itself. Phone-source commands use `WCSession.sendMessage`, guarded by `isReachable`.
- Complications still use ClockKit (`CLKComplicationDataSource`), which is legacy; iOS widgets use WidgetKit accessory families.

#### 32. omi
- Mobile app in Flutter, macOS app in Swift/SwiftUI, and a small watchOS recorder.
- Watch recorder (`omiWatchApp/ContentView.swift`):
  - A black screen with one 80 pt white button.
  - A ripple animation plays only for the first 5 s. After that it shows a static `Text(startedAt, style: .timer)` in rounded monospaced digits.
- `capture_state_labels.dart`: one function names each capture state for every surface — Listening, Capturing, Recording, Paused, Muted, Reconnecting…, "Offline, buffering (· Nm)", Transcription unavailable, Processing.
  - States resolve in a fixed priority order.
  - Small surfaces get compact variants.
- `PRODUCT.md`: "Trust over cleverness", and silent data loss counts as a product bug.

#### 33. WhisperKit (argmax-oss-swift)
- On-device Whisper STT, plus TTSKit and SpeakerKit. The package supports watchOS 10.
- The watch example shows confirmed segments in bold and unconfirmed ones in light weight, anchored with `defaultScrollAnchor(.bottom)`. It offers the tiny and base models.

### F. Voice-first references

#### 34. LiveKit (agents, agent-starter-swift, components-swift)
- The starter runs on iOS, iPadOS, macOS and visionOS.
  - Voice, text and video input are toggled through environment values.
  - `AgentView` shows either an avatar video or a `BarAudioVisualizer`, and moves between modes with `matchedGeometryEffect`.
- Transcript layout: user text in a bubble on the right, agent text plain on the left.
- `BarAudioVisualizer` gives each state its own motion:
  - idle / initializing: a symmetric sweep
  - listening: the centre bar blinks (0.5 s)
  - thinking: a fast scanner (0.15 s)
  - speaking: all bars follow the audio
- Weight: `client-sdk-swift` brings in WebRTC.

#### 35. Pipecat (pipecat, pipecat-client-ios, voice-ui-kit)
- RTVI delegate events that can drive UI states:
  - `onBotReady`
  - `onUserStarted/StoppedSpeaking`
  - `onUserTranscript`, whose `Transcript` has a `final` flag (interim vs final)
  - `onBotLlmStarted/Text/Stopped`
  - `onBotTtsStarted/Text/Stopped`
  - `onBotStarted/StoppedSpeaking`
- `voice-ui-kit` is React: a debug console and templates.

### G. Motion

#### 36–38. Pow, open-swiftui-animations, SwiftUI-Shimmer
- Pow (iOS 15+): `changeEffect` (shine, spray, ping, haptic and sound feedback) and more than 20 transitions. It is decorative and works as a catalogue.
- open-swiftui-animations: recipes that use only native SwiftUI, for example `GlassEffectContainer` + `PhaseAnimator` morphing two glass buttons.
- SwiftUI-Shimmer: a one-modifier shimmer (active, animation, gradient, band size). The pattern is only a few dozen lines to copy.

---

## 3. Adoptable ideas

Apple platform facts these ideas rely on (checked in Apple docs unless marked):

**iOS 26**
- `tabViewBottomAccessory(content:)` is iOS 26.0; the `isEnabled:` variant is 26.1. `tabBarMinimizeBehavior` is iOS 26.
- `glassEffect`, `GlassEffectContainer`, `glassEffectID`, `scrollEdgeEffectStyle`, `safeAreaBar` and `backgroundExtensionEffect` are iOS 26 and watchOS 26. `ToolbarSpacer` is iOS 26 but not watchOS.
- `BGContinuedProcessingTask` (iOS 26): the system shows the task's title, subtitle and progress in a Live Activity and lets the user cancel it. Tasks with little progress are ended first.

**iOS 27**
- `defaultTabBarPlacement(_:)` and `swipeActionsContainer()` are iOS/watchOS 27.
- The iOS 27 SDK, per session 278:
  - requires the UIScene lifecycle;
  - makes iPhone apps resizable (iPhone Mirroring, iPhone apps on iPad);
  - tells developers to replace `UIScreen.main` and idiom checks.

**Speech and the watch**
- `SpeechAnalyzer`, `SpeechTranscriber`, `DictationTranscriber` and `SFSpeechRecognizer` are not available on watchOS.
- On watchOS: `AVSpeechSynthesizer` (2+), `TextFieldLink` (9+), `handGestureShortcut` (11+), `ControlWidget` (26+), RelevanceKit (26+).
- `PrivateCloudComputeLanguageModel` is iOS/watchOS 27. The on-device `SystemLanguageModel` is not on watchOS.
- Notifications: on Series 9 / Ultra 2, double tap on a notification runs the first non-destructive action.

**Live Activities**
- They appear in the watch Smart Stack automatically.
- An alert update shows the compact leading/trailing views and then opens the Smart Stack.
- An opt-in Info.plist key lets the watch app launch from a Live Activity.
- `supplementalActivityFamilies` is iOS 18. Updates are limited to 4 KB. Buttons and toggles work through App Intents; whether they work in the watch Smart Stack is unverified.

**Watch networking (TN3135)**
- watchOS blocks low-level networking, including `URLSessionWebSocketTask`, `URLSessionStreamTask` and `NWConnection`. The only exceptions are audio-streaming apps, VoIP during a call, and a tvOS listener.
- The simulator always allows it. Test on a device with the iPhone's Wi-Fi and Bluetooth turned off in Settings.

**Liquid Glass guidance**
- Remove custom bar backgrounds.
- Don't overuse glass.
- Test with Reduce Transparency and Reduce Motion.

### 3.1 iPhone

1. **Stable list while streaming.**
   - What: while the user drags or scrolls, queue incoming rows and apply them when the gesture settles. Serialize list transactions.
   - Source: Element X (`hasPendingItems`), exyte/Chat (actor UpdateQueue, phased diffs), Telegram (`ListViewTransactionQueue`).
   - Benefit: reading history during a run no longer jumps.
   - Cost: roughly 50–100 lines in the existing UIKit list host (already 29 `UIHostingConfiguration` uses). No dependencies.

2. **Explicit follow latch.**
   - What: auto-follow turns on and off only on real signals. Show the scroll-to-bottom pill only when it helps (80 pt idle / 160 pt while streaming).
   - Source: hermex `ChatScrollPolicy`, ListViewKit (`isScrolledToBottom(tolerance:)` && `!isUserInteractingWithScroll`), fullmoon (`scrollInterrupted`).
   - Benefit: the app never fights the reader.
   - Cost: one small policy type plus unit tests.

3. **Flush timing independent of token rate.**
   - What: flush streamed text every 50–100 ms instead of on every token. Keep the existing `TextFadeAnimator` as the reveal layer.
   - Source: Enchanted (`Throttler` 0.1 s), fullmoon (every 4 tokens), hermex (~48 ms reveal with a 0.15 s easeOut follow).
   - Benefit: smoother text and less CPU on long answers.
   - Cost: trivial.
   - **Avoid:** a per-character `Timer` that re-renders the whole Markdown each time. stream-chat-swift-ai does exactly this (5 ms interval over MarkdownUI).

4. **Measure once, cache heights, open at the bottom.**
   - What: compute row heights off the main thread, cache them, and size the first fetch to fill one screen.
   - Source: Signal (`CVLoader` + `CVCellMeasurement` off-main, first fetch sized to the screen), NetNewsWire (`MultilineUILabelSizer`), Agmente (`ChatHeightCache`, `ChatMarkdownPackageCache`), ListViewKit (height closures).
   - Benefit: sessions with 1000+ messages open instantly and scroll smoothly.
   - Cost: moderate, because the cache must be invalidated when width or Dynamic Type changes. No dependencies.

5. **One motion file; Reduce Motion means snap.**
   - What: put every curve in one enum. With Reduce Motion return `nil` instead of a shorter ease. Replace ad-hoc `withAnimation` calls over time.
   - Source: hermex `ChatMotion`, mimi-remote `MimiMotion` and press style.
   - Benefit: consistent premium feel that is also accessible.
   - Cost: one file.

6. **Haptic and sound vocabulary, used sparingly.**
   - What: map events to feedback (send → light, done → success, cancel → medium, deny → warning) using `.sensoryFeedback`.
   - Source: hermex `ChatHaptics`, Ice Cubes `HapticManager` (prepared generators) + `SoundEffectManager`, Conduck ("one chime per burst").
   - Benefit: tactile confirmation of state changes.
   - Cost: trivial.
   - **Avoid:** a haptic per streamed token (fullmoon) — it drains battery and annoys.

7. **Morphing glass composer.**
   - What:
     - One trailing Button whose single Image morphs mic → send → stop with `.contentTransition(.symbolEffect(.replace))`. Identity must stay stable.
     - A `GlassEffectContainer` holding `.glass` / `.glassProminent` buttons and an interactive glass field.
     - ⌘Return sends.
   - Source: Conduck `iOSMessageComposerBar`, Element X (mic/send swap), fullmoon (send → stop), Ice Cubes `ConversationInputView`, mimi-remote.
   - Benefit: fewer controls and fluid state changes.
   - Cost: small, iOS 26 with fallback.

8. **"Agent running" bar above the tab bar.**
   - What: `tabViewBottomAccessory` shows running agents, like Music's mini player. `tabBarMinimizeBehavior(.onScrollDown)` collapses it while reading.
   - Source: Apple iOS 26 APIs (currently 0 uses). TabView shell pattern from Ice Cubes.
   - Benefit: background runs are visible and one tap away from any tab.
   - Cost: small. Needs a `TabView` root. The show/hide variant needs 26.1.

9. **One run-state vocabulary everywhere.**
   - What: list rows, Live Activity and watch use the same states: working, answered (unseen), failed, waiting-for-approval. Status comes from the tool kind. Stop appears only when this device can cancel.
   - Source: Conduck spec, hermex `AgentRunActivityAttributes`, omi `captureStateLabel`.
   - Benefit: glanceable status across many agents, with the same words on every surface.
   - Cost: a small enum and mapping.

10. **Live Activity polish.**
    - What:
      - Counts and status only on the Lock Screen, no reply text.
      - Elapsed time with `Text(timerInterval:)` and a stale flag.
      - `.supplementalActivityFamilies([.small])`, so the Smart Stack and CarPlay get a purpose-built small view.
      - `update(_:alertConfiguration:)` only for "needs approval" and "done". It also pings the watch.
      - Deep-link straight into the run.
    - Source: hermex, Home Assistant, Apple ActivityKit docs.
    - Benefit: a premium Dynamic Island, privacy on the Lock Screen, and a wrist presence for free.
    - Cost: widget code only. Keep each update under 4 KB.

11. **Honest background continuation.**
    - What: for long user-started runs, use `BGContinuedProcessingTask`, which the app already references 5 times, and report real progress so the system does not end it as stuck.
    - Source: PhoneClaw `LiveLandBackgroundContinuation`, Apple docs.
    - Benefit: runs survive app switches, with system progress and cancel UI.
    - Cost: small.
    - **Avoid:** keeping agents alive through `UIBackgroundModes: audio` or "sound effects" keep-alives (the FlowDown note). App Review and battery risk.

12. **Calm progress presentation.**
    - What: a collapsible "Thought for Ns"; a shimmer on the in-progress label (copy the ~20-line mask-gradient pattern; no dependency); tool calls as timeline rows with per-tool renderers; `.monospacedDigit()` timers and counters.
    - Source: fullmoon, SwiftUI-Shimmer, Agmente and Happy (tool rows), Element X and omi (digits).
    - Benefit: activity is legible and doesn't jitter.
    - Cost: trivial.

13. **Liquid Glass restraint.**
    - What:
      - Use `.safeAreaBar` + `.scrollEdgeEffectStyle(.soft, for: .top)` instead of custom bar backgrounds.
      - Morph paired controls with `glassEffectID`.
      - Keep glass off message content.
      - Put all availability-gated glass in one helper.
    - Source: Apple "Adopting Liquid Glass", Ice Cubes, Wikipedia, watchGPT `LiquidGlass.swift`.
    - Benefit: modern look at no performance cost.
    - Cost: small.

14. **Type scale built on Dynamic Type.**
    - What: every font through `UIFontMetrics` / `relativeTo:`; `@ScaledMetric` for icon sizes and paddings (0 uses today); optionally a serif or rounded accent for titles.
    - Source: Wikipedia `WMFFont` (Georgia for reading headers), Ice Cubes `Font.swift`, Element X.
    - Benefit: clear hierarchy that survives large text.
    - Cost: small. Uses built-in fonts only.

15. **Accessibility audit in CI.**
    - What: auto-generate a `performAccessibilityAudit` test for every SwiftUI preview.
    - Source: Element X `AccessibilityTests` (Sourcery).
    - Benefit: labels, contrast and hit-target regressions are caught automatically.
    - Cost: test target only. Zero app binary cost.

16. **Keep Markdown native and phone-first.**
    - What: keep swift-cmark. Lay out tables and code as separate blocks. Highlight a code block only after it closes.
    - Source: Lakr233 MarkdownView (blocks pulled out of lists, async highlighting).
    - Benefit: premium reading without extra weight.
    - Cost: none new.
    - **Avoid:** JavaScriptCore highlighters in the streaming path — Highlightr (both MarkdownViews) and Prism via `JSContext` (Textual).

17. **Siri and Action Button brevity.**
    - What: intents that return short spoken answers (a voice cap such as "≤ 4 sentences") and run without opening the app where possible. Register them with `AppShortcutsProvider`.
    - Source: fullmoon `RequestLLMIntent`, Ice Cubes `InlinePostIntent`, Conduck.
    - Benefit: good hands-free answers.
    - Cost: small.

18. **Zoom transitions for screenshots, files and browser captures.**
    - What: `matchedTransitionSource` + `.navigationTransition(.zoom)` + `.presentationSizing(.page)`.
    - Source: Ice Cubes media viewer, hermex `ImageLightboxView`.
    - Benefit: continuity when opening media.
    - Cost: trivial (the app already uses `navigationTransition` 3 times).

19. **Voice-mode visuals without the SDK weight.**
    - What:
      - A 5-bar visualizer with a distinct motion per state: sweep (idle), blink (listening), scanner (thinking), audio-driven (speaking).
      - Show interim vs final transcript in light vs bold.
      - Drive the UI from a small event set: user speaking, interim/final, model started, TTS speaking.
    - Source: LiveKit `BarAudioVisualizer`, Pipecat RTVI events, WhisperKit example.
    - Benefit: users can tell whether the app is listening, thinking or speaking.
    - Cost: ~100 lines of SwiftUI.
    - **Avoid:** the LiveKit or Pipecat SDKs (WebRTC) unless full-duplex realtime voice becomes a core feature.

20. **iOS 27 extras behind availability checks.**
    - What:
      - `swipeActionsContainer()` for swipe actions on `LazyVStack` rows (verified in docs).
      - `@State` becomes a macro with lazy init.
      - AsyncImage uses the HTTP cache.
      - Toolbar `visibilityPriority` (per session page).
    - Source: WWDC26 "What's new in SwiftUI".
    - Benefit: less custom code.
    - Cost: availability gates only.

### 3.2 iPad

1. **iOS 27 resizability cleanup (do first).**
   - What: replace `UIScreen.main` (27 uses) and `userInterfaceIdiom` checks (3) with size classes, container geometry, or `UIWindowScene.effectiveGeometry`. Keep the scene lifecycle (multiple scenes are already enabled).
   - Source: WWDC26 "Modernize your UIKit app" (per session page); mimi-remote and Ice Cubes decide by size class.
   - Benefit: correct layouts in Stage Manager windows, Split View, iPhone Mirroring, and any resizable window.
   - Cost: mechanical. Xcode 27's modernization skill can help. No dependencies.

2. **Adaptive shell.**
   - What: `TabView(.sidebarAdaptable)`, with sidebar-only `TabSection`s for power areas (Runs, Skills, Memory, Knowledge, Sandbox, Macs). On iOS 27 add `.defaultTabBarPlacement(.sidebar)` in regular width.
   - Source: Ice Cubes `AppView`.
   - Benefit: the native Liquid Glass sidebar from one code path.
   - Cost: small.

3. **Compact = push, regular = split.**
   - What: don't rely on `NavigationSplitView` collapsing, because the collapsed detail loses its back stack and edge-swipe. Use sidebar widths of 260/300/340.
   - Source: mimi-remote `UnifiedWorkbenchShell`.
   - Benefit: correct back gestures in narrow windows and Slide Over.
   - Cost: a small routing change.

4. **Inspector column for agent context.**
   - What: `.inspector(isPresented:)` beside the chat, showing tool calls, file diffs, sandbox output, memory hits and run details.
   - Source: mimi-remote (`SessionInspectorView`, `DiffPanelView`, sub-agent pane), CodeEdit InspectorArea.
   - Benefit: see what the agent is doing without leaving the conversation.
   - Cost: reuses existing views. 0 inspector uses today.

5. **Readable width on big screens.**
   - What: `contentMargins(.horizontal, max((w − maxW)/2, 0), for: .scrollContent)`, capped at ~800–1000 pt, so the scroll indicator stays at the window edge. Tune spacing per device.
   - Source: hermex `adaptiveReadableScrollContent`, mimi-remote.
   - Benefit: comfortable line length on 13" iPads.
   - Cost: ~40 lines.

6. **Menu bar done right (iPadOS 26).**
   - What: `.commands { CommandMenu / CommandGroup }` with symbols and shortcuts, ordered by frequency. Tabs go in the View menu with ⌘1…⌘n, plus a sidebar toggle. Items are dimmed when unavailable, never hidden.
   - Source: WWDC25-208 guidance, Ice Cubes `IceCubesApp+Menu`, Conduck (⌘N/⌘1/⌘2).
   - Benefit: discoverable power features.
   - Cost: small (6 command uses already).

7. **Key commands scoped to context that yield to typing.**
   - What: per-context `UIKeyCommand` sets with `wantsPriorityOverSystemBehavior`, returning nothing while a text field is first responder. j/k style list navigation. ↑/↓/Tab/Esc for composer autocomplete.
   - Source: NetNewsWire `KeyboardManager` (context plists), Mastodon (j/k/h/l with discoverability titles), mimi-remote `ComposerTextEditor`.
   - Benefit: fast keyboard use that never steals text input.
   - Cost: small.

8. **⌘K command palette.**
   - What: one registry of commands (skills, models, sessions, Macs, settings). Filter by "contains", select the first result, bold the match. Use fuzzy search for sessions and files.
   - Source: CodeEdit `QuickActionsViewModel` + Open Quickly, Blink `fuzzy.swift`.
   - Benefit: one entry point for everything.
   - Cost: one sheet plus a registry. No dependencies.

9. **Session, run and terminal windows.**
   - What: `WindowGroup(for: SessionID.self)` + `openWindow(value:)`, with descriptive window titles. Each window keeps its own state.
   - Source: Ice Cubes (composer and media windows), a-Shell (per-window context), WWDC25-208 ("a new window for each document").
   - Benefit: agents side by side in Stage Manager.
   - Cost: small (`openWindow` has 0 uses today).

10. **Drag and drop both ways.**
    - What: `dropDestination` on the composer for files, images and URLs; `draggable` on results, files and images.
    - Source: Ice Cubes (`.draggable` rows and media, editor `.onDrop`), Code App (dragging from the file tree and tabs).
    - Benefit: works naturally with Split View.
    - Cost: small (4 drop and 0 drag uses today).

11. **Pointer and press polish.**
    - What: `.hoverEffect(.highlight)` on rows and toolbar items; press state scale 0.985 at 0.84 opacity; precedence pressed > focused > hovered.
    - Source: mimi-remote, Ice Cubes. Standard buttons get the iPadOS 26 glass hover platter for free.
    - Benefit: precise and tactile with a trackpad.
    - Cost: tiny.

12. **Persistent, resizable terminal panel in wide layouts.**
    - What: a drag-resizable bottom panel holding the existing terminal, plus hardware-keyboard modifier handling and a compact keys bar.
    - Source: Code App `PanelView`, Blink `SmarterKeys` and remaps. SwiftTerm is the feature reference (selection, search, hyperlinks, Metal).
    - Benefit: watch the sandbox while chatting.
    - Cost: layout-only if the in-house emulator is kept.
    - Swapping to SwiftTerm (MIT, pure Swift) makes sense only if the in-house emulator has gaps.

13. **Activity viewer in the toolbar.**
    - What: running agents shown with circular progress and a notification list.
    - Source: CodeEdit ActivityViewer.
    - Benefit: Mac-like awareness of what's running.
    - Cost: small; reuses the run-state model from iPhone idea 9.

14. **Restore scenes.**
    - What: `@SceneStorage` for sidebar visibility and the selected session.
    - Source: mimi-remote, NetNewsWire `stateRestorationActivity`.
    - Benefit: windows come back as the user left them.
    - Cost: tiny.

15. **Sheets sized for iPad.**
    - What: `.presentationSizing(.form)` for settings and pickers, `.page` for viewers.
    - Source: hermex, Ice Cubes.
    - Benefit: no full-height sheets on a 13" screen.
    - Cost: tiny.

16. **iOS 27 toolbar priorities.**
    - What: `visibilityPriority(.high)` for Send/Stop/Approve; `ToolbarOverflowMenu` for secondary items.
    - Source: WWDC26 SwiftUI session (per session page; verify in the SDK).
    - Benefit: critical actions never fall into overflow in narrow windows.
    - Cost: availability gates.

17. **Avoid: embedding an IDE editor just to show code.**
    - Monaco in WKWebView (Code App) or tree-sitter grammars (Runestone) bring binary and memory cost. Use read-only attributed code views unless editing becomes a core feature.

### 3.3 Apple Watch

1. **HTTPS request/response only, with a background fallback.**
   - What:
     - No WebSockets or streams on the watch.
     - Keep the current non-streaming direct call (`stream: false`).
     - If the wrist drops or a request fails, re-issue it as a `URLSessionConfiguration.background` task with `allowsCellularAccess`.
     - Poll short (Pinch uses 1.2 s) only while the app is in the foreground.
   - Source: TN3135, Pinch, watchGPT, Conduck (`WatchAudioUploader`).
   - Benefit: reliable on LTE, and answers still land after the wrist drops.
   - Cost: small. No persistent sockets, so battery-friendly.

2. **Honest route and error copy.**
   - What: a small "via iPhone / direct" indicator. On `-1009`, show hedged copy that the nearby iPhone may be carrying the watch's traffic.
   - Source: Conduck `WatchNetworkFailureCopy`, Home Assistant `iphone.slash`, watchGPT reachability pill, Pocket Casts source glyph.
   - Benefit: fewer mystery failures.
   - Cost: tiny.

3. **Approval card for the wrist.**
   - What:
     - A docked, non-blocking card with a risk-coloured title and the diff or command in a height-capped (~64 pt) scroll area.
     - Tap-only Allow/Deny. The crown scrolls; it must never approve on a screen where it also scrolls.
     - High-risk requests hide "remember" and tint Allow orange.
     - For the highest-risk actions, add a dedicated turn-to-confirm screen that resets if the crown stops.
   - Source: Pinch `PermissionCardView`, Loop `BolusConfirmationView`, hermex haptics.
   - Benefit: fast approvals without accidental ones.
   - Cost: small SwiftUI. No dependencies.

4. **Notification actions as the fallback approval path.**
   - Problem today: `LeoWatch` approvals fail when `WCSession.isReachable` is false.
   - What:
     - Add a `UNNotificationCategory` with Approve and Deny.
     - Double tap runs the first non-destructive action on Series 9 / Ultra 2, so the safe choice ("Open" or "Deny") must come first.
     - Mark a high-risk Approve `.authenticationRequired`.
     - Don't rely on text-input actions for iPhone-forwarded notifications; watchOS drops the typed text.
   - Source: Apple actionable-notification docs, Home Assistant `NotificationActionSplit`.
   - Benefit: approve from the wrist when the app isn't open or the phone is far away.
   - Cost: categories and a handler in the iOS app.

5. **Live Activity built for the Smart Stack.**
   - What: a purpose-built `.small` supplemental family (currently 0 uses). Alert updates only for "needs approval" and "done". Opt in to launching the watch app from the activity through the Info.plist key.
   - Source: Home Assistant, Apple docs, hermex (counts-only content).
   - Benefit: glanceable progress on the wrist with no watch-app code.
   - Cost: widget extension on the iPhone only.

6. **One-press Ask.**
   - What: a watch `ControlWidget` ("Ask Leo") for Control Center, the Smart Stack and the Action Button, plus a watch `AppShortcutsProvider` so the intent is indexed at install.
   - Source: Conduck (`ConduckWatchControl` + `WatchAppShortcuts`), Home Assistant `ControlAssist`.
   - Benefit: talk to the agent in one press.
   - Cost: small (watchOS 26 ControlWidget).

7. **Speech etiquette.**
   - What:
     - Auto-speak only while the app is active, or on wrist raise within a freshness window.
     - Pause TTS on wrist-down or dim (`scenePhase`, `isLuminanceReduced`) and resume on raise. The mic stops TTS.
     - One speak engine per device.
     - Sanitize text before speaking (Markdown, URLs, emoji, control characters).
     - Deactivate the audio session with `.notifyOthersOnDeactivation` so ducked music comes back.
   - Source: Conduck (`WatchReplySpeaker`, `ReplySanitizer`), Pinch (AirPods readback plus haptic).
   - Benefit: no surprise audio, no cut-off replies, no spoken asterisks.
   - Cost: small, and it saves battery.

8. **Motion that respects battery and Always On.**
   - What: pause `TimelineView` / `repeatForever` when the app is inactive, luminance is reduced, or Reduce Motion is on. Switch to a grayscale look in Always On. Build heavy visuals only while recording, and after a few seconds switch to a static timer.
   - Source: watchGPT, omi (ripple for 5 s, then `Text(.timer)`), Home Assistant (orb only while recording).
   - Benefit: longer battery and a calm Always On display.
   - Cost: tiny — `WatchMotionViews` has 3 `repeatForever` animations and 0 `isLuminanceReduced` checks today.

9. **One morphing primary control.**
   - What: a single Image that morphs mic → send → stop, with click haptics. Keep the `TextField`/`TextFieldLink` as the launcher for system scribble and dictation. Attach `handGestureShortcut(.primaryAction)` to a stable control outside any `ScrollView`/`List` (Pinch notes it may not fire inside them).
   - Source: Conduck `WatchMessageComposerBar`, Home Assistant, Pinch.
   - Benefit: predictable one-handed use.
   - Cost: tiny.

10. **Scroll stability.**
    - What: snap to the newest reply without animation, then re-snap within a short bounded window while the height settles. Use `LazyVStack` rather than `List` to avoid minimum row heights. Use `defaultScrollAnchor(.bottom)`.
    - Source: Conduck, Home Assistant, WhisperKit example.
    - Benefit: the new answer is always visible, without jitter.
    - Cost: tiny.

11. **Plain text, glance first.**
    - What: a one-line headline, then plain text. A voice cap on replies (the app already sets 600 max tokens; add "≤ 4 sentences" for spoken replies). Short compact state labels.
    - Source: Conduck (no Markdown on the watch), fullmoon (4-sentence voice cap), omi (compact labels).
    - Benefit: readable on 41–49 mm screens.
    - Cost: none.
    - **Avoid:** Markdown renderers on the watch (Lakr233 `WatchMarkdownView`, Textual on watchOS) — binary size for little gain.

12. **Warm up the phone and deliver on two channels.**
    - What: send a tiny "wakeup" to the iPhone as recording starts. Send critical small payloads with both `sendMessage` and `transferUserInfo`, de-duplicated by ID. Use `updateApplicationContext` for the latest state.
    - Source: Home Assistant `WatchAssistViewModel.assist`, Conduck `WatchSessionManager`.
    - Benefit: lower relay latency, and nothing is lost across sleep.
    - Cost: small.

13. **Smart Stack relevance for pending approvals.**
    - What: a watch widget that becomes relevant while an approval is pending, using RelevanceKit / `WidgetRelevance`.
    - Source: Apple RelevanceKit (watchOS 26), Home Assistant widget snapshot store.
    - Benefit: the widget surfaces on its own when action is needed.
    - Cost: widget only.

14. **Optional: watchOS 27 summaries through Private Cloud Compute.**
    - What: use `PrivateCloudComputeLanguageModel` (no API key, daily quota, 32K context) to condense long agent results into a glance plus a spoken line.
    - Source: WWDC26 Foundation Models session; Conduck and ETOS show the value of short wrist answers.
    - Benefit: short, speakable results without spending the user's tokens.
    - Cost: watchOS 27 gate, network, quota; must degrade gracefully. Optional.

15. **Avoid: keep-alive hacks and on-watch speech models.**
    - `WKExtendedRuntimeSession` with a `self-care` mode (Home Assistant) or workout runtime (watchGPT) risks App Review rejection and drains battery. Prefer background URLSession plus a notification.
    - Don't put WhisperKit models on the watch. `SFSpeechRecognizer` and `SpeechAnalyzer` aren't available there, so use `TextFieldLink` / system dictation or record and send.
    - Don't attempt realtime speech-to-speech from the watch alone. It needs WebSockets, which TN3135 blocks.

16. **Optional: wrist gestures.**
    - What: shake to cancel a running turn; double tap to send.
    - Source: Pinch (`ShakeDetector`, `handGestureShortcut`).
    - Benefit: hands-busy control.
    - Cost: CoreMotion sampling only while a turn runs, with a false-trigger risk. Ship as an opt-in.

---

## 4. Checked and rejected

| Project | URL | Reason |
|---|---|---|
| Open Interpreter 01 / 01-app | https://github.com/openinterpreter/01 | No pushes since 2024-11 (app 2024-09). README says it "lacks basic safeguards". |
| PocketPal AI | https://github.com/a-ghorbani/pocketpal-ai | React Native. Its value is managing local GGUF models, which LeoPhoneAgent doesn't target. Per-message speed stats are also covered by Conduck and ETOS. |
| LLMFarm | https://github.com/guinmoon/LLMFarm | Plain, utilitarian UI; its value is llama.cpp integration, which is out of scope. |
| MLC LLM (MLCChat) | https://github.com/mlc-ai/mlc-llm | The iOS app is a demo UI for the inference engine. |
| Mastodon iOS | https://github.com/mastodon/mastodon-ios | UIKit; no split-view iPad layout found in the current tree. Only the j/k key commands are useful (used in iPad idea 7). |
| IcySky | https://github.com/Dimillian/IcySky | Stale (2025-06), described as "TBD". Ice Cubes covers the same author's patterns. |
| huggingface/swift-chat | https://github.com/huggingface/swift-chat | Archived. |
| PlaticaBot | https://github.com/migueldeicaza/PlaticaBot | Stale (2023). A basic shared ChatView with watchOS `#if`s; Conduck supersedes it. |
| stream-chat-swift-ai | https://github.com/GetStream/stream-chat-swift-ai | No LICENSE file. Streams with a 5 ms per-character Timer over MarkdownUI (the anti-pattern in iPhone idea 3). Depends on Splash and MarkdownUI. |
| Open Relay | https://github.com/Ichigo3766/Open-Relay | No LICENSE file. Heavy on-device voice (~250 MB MLX TTS). CallKit-based "AI calls" carry App Review risk. The persistent iPad terminal panel is noted in iPad idea 12. |
| scarf | https://github.com/awizemann/scarf | Mac-first; the iPhone companion isn't adapted for iPad. hermex and mimi-remote cover the patterns. |
| Chatbox, Kelivo, ChatterUI, private-mind, sample-mobile-ai-assistant | (GitHub) | Electron, Flutter or React Native — not native Apple UI references. |
| google-ai-edge/gallery | https://github.com/google-ai-edge/gallery | Android-first (Kotlin). |
| UTM | https://github.com/utmapp/UTM | A virtualization reference, not a UI-polish one. |
| iSH | https://github.com/ish-app/ish | Already the upstream base (OpenMinis ships an iSH arm64 fork). |
| apple/sample-food-truck | https://github.com/apple/sample-food-truck | 2023, before Liquid Glass. |
| Onit, Ollamac | https://github.com/synth-inc/onit | macOS-only overlay or chat. Ollamac hasn't been pushed since 2025-03. |
| Wave, Inferno | https://github.com/jtrivedi/Wave | Native SwiftUI springs, `phaseAnimator` and `keyframeAnimator` cover the needs. Inferno's license shows as NOASSERTION and its Metal shaders add GPU cost. |
| Pow / exyte/Chat / LiveKit / Pipecat SDKs as **dependencies** | — | Kept only as UX references. Adding them brings decorative effects, Giphy and Kingfisher, or WebRTC weight. |
| Tiny watch LLM repos (WristMind, watch-chat, apple-watch-claude, Chime, eminersus/apple-watch-claude-code) | (GitHub) | 0–1 stars. Patterns already covered by Pinch, Conduck and watchGPT. |
| NylonDiamond/homeassistant-wrist-assistant | https://github.com/NylonDiamond/homeassistant-wrist-assistant | Server integration only; the watch app isn't in the repo. |
| Tusker (Mastodon client) | — | Not on GitHub (API returned 404); not evaluated. |
| DuckDuckGo iOS | https://github.com/duckduckgo/iOS | Archived. |
| Firefox iOS, Bitwarden, Wire, Delta Chat, Nextcloud Talk, Kiwix, Aidoku, CodeAgentsMobile, openclient-llm, hanlin-ai, SwiftyChat, mimir-ios | (GitHub) | Metadata checked only, not evaluated in depth (time-boxed). None looked stronger than the kept set for this domain. |
