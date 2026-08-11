import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * The session watcher must NOT hold a file descriptor per watched file.
 *
 * It used to (chokidar): with ~19k transcripts under ~/.claude/projects the app
 * accumulated ~19k open fds, and once the process ran out, EVERY subsequent
 * spawn failed with `spawn EBADF`. That is what made "更新" fail reliably the
 * longer the app had been running — no amount of retrying can fix exhaustion.
 *
 * Measured at the time of the fix: chokidar +2000 fds for 2000 files, native
 * recursive fs.watch +0.
 */
const openFdCount = (): number => Number(execSync(`lsof -p ${process.pid} 2>/dev/null | wc -l`).toString().trim());

test('watching a directory of many files costs no per-file file descriptors', { skip: process.platform !== 'darwin' && process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-fd-'));
  const FILES = 500;
  try {
    for (let i = 0; i < FILES; i += 1) fs.writeFileSync(path.join(dir, `session-${i}.jsonl`), '{}\n');

    const before = openFdCount();
    const watcher = fs.watch(dir, { recursive: true, persistent: true }, () => { /* events unused here */ });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = openFdCount();
    watcher.close();

    // A per-file watcher would add ~FILES descriptors here. Allow a small
    // constant for the watch handle itself and unrelated test noise.
    assert.ok(
      after - before < 50,
      `watching ${FILES} files added ${after - before} file descriptors — the watcher is holding one per file again`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
