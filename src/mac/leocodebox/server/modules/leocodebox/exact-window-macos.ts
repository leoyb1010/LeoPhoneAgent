import { execFileSync } from 'node:child_process';

import { exactWindows, type WindowSnapshot } from './exact-window.js';

const LIST_SCRIPT = `
tell application "System Events"
  set rows to {}
  set frontName to name of first application process whose frontmost is true
  repeat with p in (every application process whose background only is false)
    set pname to name of p
    set ppid to unix id of p
    set isFront to (pname is frontName)
    try
      repeat with w in windows of p
        set end of rows to pname & tab & (ppid as text) & tab & (id of w as text) & tab & (name of w) & tab & (isFront as text)
      end repeat
    end try
  end repeat
  set AppleScript's text item delimiters to linefeed
  return rows as text
end tell
`;

export type ListedWindow = {
  app: string;
  pid: number;
  windowId: string;
  title: string;
  frontmost: boolean;
};

export function listMacWindows(): ListedWindow[] {
  if (process.platform !== 'darwin') return [];
  let raw = '';
  try {
    raw = execFileSync('osascript', ['-e', LIST_SCRIPT], {
      encoding: 'utf8',
      timeout: 4000,
    });
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [app, pid, windowId, title, front] = line.split('\t');
      return {
        app: app ?? '',
        pid: Number(pid) || 0,
        windowId: windowId ?? '',
        title: title ?? '',
        frontmost: front === 'true',
      };
    })
    .filter((row) => row.app && row.windowId);
}

export function captureListed(row: ListedWindow): WindowSnapshot {
  return exactWindows.capture({
    app: row.app,
    pid: row.pid,
    windowId: row.windowId,
    title: row.title,
    frontmost: row.frontmost,
    bounds: 'unknown',
  });
}

export function bindFrontmostToSession(sessionId: string): WindowSnapshot | null {
  const front = listMacWindows().find((row) => row.frontmost);
  if (!front) return null;
  const snap = captureListed(front);
  exactWindows.bindSession(sessionId, snap.snapshotId);
  return snap;
}
