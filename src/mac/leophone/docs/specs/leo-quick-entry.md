# Leo quick entry: menu bar + ⌥Space panel (macOS)

## Rule

From any app the user can see what LeoBot is doing and hand it a new task without
switching windows.

## Owners and data flow

```
 Host (port owner)                      Main                               Panels
 ───────────────────                    ────                               ──────
 IWindowControllerService.listTaskList  GET /api/leo/quick/summary  ──►   Tray (title = running count,
   (live phase / pending interactions)    (Bearer main key + x-leo-pair)     menu: 待审批 / 运行中 / 最近)
 settings.lastWorkspaceSession +        POST /api/leo/quick/dispatch ◄──  ⌥Space panel (input +
   recentProjects  → workspace list       { workspacePath, prompt }         workspace select)
 IZCodeTaskService.createTask +
   sendPrompt (desktop-continuous)
```

- Task state is owned by the Host. Main only polls and forwards; it keeps no task state
  beyond the last summary it rendered.
- Both endpoints require the main key **and** the per-launch pair secret held only by Main
  and the Host, so a local agent that can read `~/.leoagent/key` cannot spawn tasks.
- Dispatch only accepts a workspace from the summary's workspace list (open local
  workspaces first, then recent projects; at most 5, must exist on disk) and a non-empty
  prompt up to 20 000 characters. Mode and model follow the workspace defaults (same as a
  task created from the phone).

## Menu bar (Tray)

- macOS only (Windows keeps the upstream tray). Template icon `build/trayTemplate{,@2x}.png`.
- Title shows the running count only when > 0.
- Menu: 待审批 N (each opens the task in the main window), 运行中 (≤ 5), 最近 (≤ 3),
  新任务 (shows the panel, with the current accelerator), 打开 LeoBot, 退出.
- Polling: 3 s while something runs or waits, 15 s otherwise, refreshed right after a
  dispatch and whenever the menu opens. Host unreachable → menu shows a single disabled line.

## Quick panel

- Global shortcut, default `Alt+Space`, user-changeable; registration failure is reported in
  settings ("被占用") and the previous working accelerator stays.
- Frameless `type: "panel"` window, 640×128, always on top, visible on all Spaces and over
  full-screen apps, placed in the upper third of the display under the mouse.
- Hides on blur, Esc, or 600 ms after a successful dispatch ("已派发"). ⌘↩ dispatches and
  opens the new task in the main window.
- Pre-created hidden a few seconds after launch so the shortcut shows it immediately.
- Appearance follows the app's theme setting (light / dark / system), not the system appearance:
  the main window's `SetTitleBarTheme` sync calls `setLeoQuickPanelAppTheme`, the value is persisted
  as `appTheme` in `leo-quick-entry.json` (so it is right before the main window syncs after a
  relaunch) and sent with every panel state push. The panel sets `theme-zai-light` /
  `theme-zai-dark` on `<html>` (same classes as the main window, read by `leo-tokens.css` and the
  panel's own styles); "system" removes them and falls back to `prefers-color-scheme`.

## Settings

通用 → 快捷键 shows a "菜单栏与快速派发" block (macOS desktop only):
菜单栏图标 on/off, 快速派发 on/off, accelerator recorder (needs at least one of ⌘/⌃/⌥, not
Shift-only). Stored by Main in `userData/leo-quick-entry.json`.

## Verification

- `node --import tsx --test packages/desktop/src/main/leo/quickPanelCore.test.ts`
  (placement, accelerator validation, poll delay, menu model).
- `node --import tsx --test packages/desktop/src/host/leo/quickEntry.test.ts`
  (summary classification, workspace list, dispatch validation).
- Manual: `pnpm dev:desktop`, ⌥Space from another app, dispatch, task appears in sidebar,
  tray count changes, 待审批 opens the task.
