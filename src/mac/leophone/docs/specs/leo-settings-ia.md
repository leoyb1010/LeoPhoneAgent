# Leo settings information architecture

## Rule

Settings follows the iOS LeoBot layout (`src/ios/Views/Settings/SettingsHomeView.swift`):
few groups, searchable, one line of hint per item, compact rows.

### Groups (nav order)

| Group (zh / en)          | Nav entries (section ids)                                               |
| ------------------------ | ----------------------------------------------------------------------- |
| AI 服务商 / AI Providers | 模型设置 `modelProvider`                                                |
| 智能体 / Agent           | 记忆 `memory`, 子智能体 `subagents`, 扩展 `extensions`                  |
| 我的设备 / Devices       | 连接手机 `phone` (desktop only), 浏览器 `browser`                       |
| 通用 / General           | 常规 `general`, 外观 `appearance`, 快捷键 `shortcuts`, 使用统计 `usage` |

Hidden sections (`automations`, `plugins`, `workspaceFileSearch`, `computerUse`) stay
routable ids only as before.

### 扩展 / Extensions

`extensions` is a nav entry, not a page of its own. Its page is one of the existing
sections `plugin`, `mcp`, `skill`, `commands`, `hooks`, shown under a compact
segmented tab bar (插件 / MCP / 技能 / 命令 / 钩子). The active section id is always the
tab id, so every existing caller keeps working unchanged:

- `setPendingSettingsSectionIntent("mcp")`, `setPendingSettingsPluginIntent("skills")`,
  `"hooks"` from the pending banner etc. land on 扩展 with that tab selected.
- `extensions` itself resolves to `plugin` (`resolveSettingsSection`).
- Nav item 扩展 is highlighted whenever the active section is one of the five tabs.

### Default section

Opening Settings without an explicit target always lands on `modelProvider`
(AI 服务商). The old "last visited section" memory
(`localStorage["zcode-settings-last-section"]`) is no longer read or written; the stale
value is ignored. Explicit intents (quick pick, banners, sidebar footer 连接手机/使用统计)
still win.

### Search

A search box sits at the top of the settings nav (hidden in the narrow icon rail).

- Candidates: every visible nav entry (label + hint + keywords), each 扩展 tab
  (label + keywords, context "扩展"), and the rows of 常规 (label + keywords, context
  "常规").
- Matching: case-insensitive; the query is split on whitespace and every token must
  occur in label + hint + keywords + context. Keywords hold both Chinese and English
  terms (e.g. MCP, key, 密钥, 代理, proxy, 字体, theme, 手机, Tailscale, 配对).
- While the query is non-empty the nav shows a flat result list instead of groups.
  ↑/↓ moves the highlight, Enter opens, Esc clears (a second Esc blurs), click opens.
- Opening a row result switches to 常规, scrolls the row into view and briefly
  highlights it (`data-settings-row-id`, `data-search-hit`). The query is cleared after
  a result is opened.
- No match shows a single subtle "没有匹配的设置" line.

### Header hint

The content header shows the section title and below it one hint line
(`text-ui-sm text-foreground-subtle`). Each nav entry has a zh + en hint.

### 常规 ordering

1. 界面语言
2. 任务通知, 提示音, 保持电脑运行, (Windows) 关闭到托盘, (desktop) 自动下载并安装更新
3. Conversation display (interaction behaviour, question auto-resolution, reasoning,
   todos, tool grouping, model I/O retention)
4. 数据存储路径, 任务自动归档, 归档天数
5. Terminal (profile, font, Windows shell), native search enhancements
6. HTTP 代理, No Proxy, CA certificate
7. (desktop) 硬件加速, 迁移向导

The "receive preview updates" toggle is removed: Leo builds read a single manifest
from `leoyb1010/leocodebox-updates` `releases/latest`; the preview flag only adds a
`channel` query/header that a static GitHub asset ignores. `receivePreviewUpdates` is
still accepted by the settings schema and read by the main process, harmlessly.

### Compactness

Nav rows `h-7`, small icons (`size-3.5`), group headers `text-ui-xs` subtle. Content
column keeps `SETTINGS_FRAME_CONTENT_CLASSNAME`; rows keep `SettingsRow` /
`SettingsGroupCard`.

## Owners

- `packages/ui/src/settings/settingsPageConfig.ts`: groups, nav entries, hints,
  keywords, 常规 search rows.
- `packages/ui/src/settings/settingsSearch.ts`: pure matcher.
- `packages/ui/src/lib/settingsNavigation.ts`: section ids, intents, resolution.
- `packages/ui/src/SettingsPage.tsx`: nav rendering, search UI, extension tab bar.

## Verification

- `packages/ui/test/settingsIa.test.ts`: group order, 扩展 membership, phone desktop
  gating, search matching (zh/en keywords, row hits), `extensions` resolution.
- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`.
- Renderer audit harness (`scripts/audit-full-renderer`) clicks every
  `settings-section-nav-*` entry; ids `general` and `modelProvider` are unchanged.
