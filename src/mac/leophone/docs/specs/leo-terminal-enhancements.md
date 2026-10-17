# Leo terminal enhancements (xterm 5.5)

## Rule

Keep `@xterm/xterm` 5.5 and add the matching official addons (search 0.15, webgl 0.18,
unicode11 0.8). Each xterm instance gets them once, right after `term.open()`.

- WebGL renderer by default; on load failure or context loss the addon is disposed and xterm
  falls back to its DOM renderer; later terminals in the same run stay on DOM.
  `localStorage["leo.terminal.webgl"] = "off"` disables it.
- Unicode 11 width table (CJK / emoji column widths). Requires `allowProposedApi`.
- ⌘F inside a terminal opens the terminal search bar (incremental, ↩ / ⇧↩, match count, all
  matches highlighted). The app-level "任务内查找" yields while focus is inside `.xterm`.
- Split: ⌘D opens a new terminal on the right; ⌘⇧D ends the split (the right terminal stays as
  a tab, PTY alive); clicking the right tab swaps sides; closing either side ends the split.
  All terminals stay mounted in one layer (unmounting a TerminalSession kills its PTY), only
  order / width / visibility change; the divider keeps each side between 20% and 80%.

## Verification

`node --import tsx --test test/terminalPanelSplit.test.ts` in `packages/ui`; manual check in
`pnpm dev:desktop` (renderer canvases present, ⌘F count, ⌘D / ⌘⇧D, PTY survives unsplit).
