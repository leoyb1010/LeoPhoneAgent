import { describe, expect, it } from 'vitest';

import type { FileDiff } from '@/lib/gitReview.types';
import {
  buildGitApplyCommand,
  canCopyGitApplyCommand,
  collectGitApplyPatches,
  getGitApplyCopyAvailability,
} from '../gitApplyCommand';

function diff(path: string, patch: string, kind: FileDiff['kind'] = 'text'): FileDiff {
  return {
    id: `unstaged:${path}`,
    source: 'unstaged',
    path,
    oldPath: null,
    status: 'modified',
    kind,
    size: null,
    additions: 1,
    deletions: 0,
    isBinary: kind === 'binary',
    isSubmodule: kind === 'submodule',
    isTooLarge: kind === 'too-large',
    mode: { old: null, new: null },
    index: { oldOid: null, newOid: null },
    rawHeader: '',
    rawPatch: patch,
    hunks: [],
    error: null,
  };
}

describe('git apply command helpers', () => {
  it('returns null and disabled availability for an empty list', () => {
    expect(buildGitApplyCommand([])).toBeNull();
    expect(canCopyGitApplyCommand([])).toBe(false);
  });

  it('builds a heredoc command from text raw patches', () => {
    const payload = buildGitApplyCommand([
      diff('a.ts', "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"),
      diff('b.ts', "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-one\n+two\n"),
    ]);

    expect(payload?.command).toBe(
      "git apply <<'EOF'\n" +
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n" +
      "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-one\n+two\n" +
      "EOF\n",
    );
    expect(payload?.included.map((entry) => entry.path)).toEqual(['a.ts', 'b.ts']);
    expect(payload?.skipped).toEqual([]);
  });

  it('builds a PowerShell command on Windows with a no-BOM UTF-8 temp patch', () => {
    const payload = buildGitApplyCommand([
      diff('a.ts', "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"),
    ], 'win32');

    expect(payload?.command).toContain("$patch = @'");
    expect(payload?.command).toContain('[System.Text.UTF8Encoding]::new($false)');
    expect(payload?.command).toContain('Join-Path $env:TEMP');
    expect(payload?.command).toContain('git apply "$patchFile"');
    expect(payload?.command).not.toContain("git apply <<'EOF'");
  });

  it('keeps untracked new-file patches copyable', () => {
    const payload = buildGitApplyCommand([
      {
        ...diff('new.ts', "diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+hello\n"),
        status: 'untracked',
      },
    ]);

    expect(payload?.command).toContain('new file mode 100644');
    expect(canCopyGitApplyCommand([
      {
        ...diff('new.ts', 'patch'),
        status: 'untracked',
      },
    ])).toBe(true);
  });

  it('preserves significant trailing spaces on the last patch line', () => {
    const payload = buildGitApplyCommand([
      diff('a.ts', "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new   \n"),
    ]);

    expect(payload?.command).toContain('+new   \nEOF\n');
  });

  it('skips binary and missing raw patch entries', () => {
    const result = collectGitApplyPatches([
      diff('ok.ts', 'diff --git a/ok.ts b/ok.ts\n'),
      diff('image.png', '', 'binary'),
      diff('empty.ts', ''),
    ]);

    expect(result.included.map((entry) => entry.path)).toEqual(['ok.ts']);
    expect(result.skipped).toEqual([
      { path: 'image.png', reason: 'non-text' },
      { path: 'empty.ts', reason: 'missing-patch' },
    ]);
  });

  it('disables copy availability while whitespace changes are hidden', () => {
    expect(getGitApplyCopyAvailability([
      diff('a.ts', "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"),
    ], true)).toEqual({ canCopy: false, reason: 'hide-whitespace' });
    expect(getGitApplyCopyAvailability([], false)).toEqual({ canCopy: false, reason: 'empty' });
    expect(getGitApplyCopyAvailability([
      diff('a.ts', "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"),
    ], false)).toMatchObject({ canCopy: true });
  });
});
