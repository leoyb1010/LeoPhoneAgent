import type { FileDiff } from '@/lib/gitReview.types';

export type GitApplyPatchSkipReason = 'non-text' | 'missing-patch';

export interface GitApplyPatchEntry {
  path: string;
  rawPatch: string;
}

export interface GitApplyPatchSkip {
  path: string;
  reason: GitApplyPatchSkipReason;
}

export interface GitApplyCommandPayload {
  command: string;
  included: GitApplyPatchEntry[];
  skipped: GitApplyPatchSkip[];
}

export type GitApplyCopyDisabledReason = 'empty' | 'hide-whitespace';

export type GitApplyCopyAvailability =
  | { canCopy: true; payload: GitApplyCommandPayload }
  | { canCopy: false; reason: GitApplyCopyDisabledReason };

export function collectGitApplyPatches(diffs: readonly FileDiff[]): {
  included: GitApplyPatchEntry[];
  skipped: GitApplyPatchSkip[];
} {
  const included: GitApplyPatchEntry[] = [];
  const skipped: GitApplyPatchSkip[] = [];

  for (const diff of diffs) {
    if (diff.kind !== 'text') {
      skipped.push({ path: diff.path, reason: 'non-text' });
      continue;
    }
    const rawPatch = diff.rawPatch.trim();
    if (!rawPatch) {
      skipped.push({ path: diff.path, reason: 'missing-patch' });
      continue;
    }
    // 只剥尾部换行,不能用 trimEnd():patch 末行的尾随空格是内容的一部分,
    // 剪掉会让 add 行悄悄丢空格、context 行直接 apply 失败。
    included.push({ path: diff.path, rawPatch: diff.rawPatch.replace(/\n+$/u, '') });
  }

  return { included, skipped };
}

function buildPosixGitApplyCommand(patch: string): string {
  return `git apply <<'EOF'\n${patch}\nEOF\n`;
}

function buildPowerShellGitApplyCommand(patch: string): string {
  return [
    '$patch = @\'',
    patch,
    '\'@',
    '$patchFile = Join-Path $env:TEMP ("xdt-review-" + [Guid]::NewGuid().ToString("N") + ".patch")',
    '[IO.File]::WriteAllText($patchFile, $patch, [System.Text.UTF8Encoding]::new($false))',
    'git apply "$patchFile"',
    'Remove-Item "$patchFile" -ErrorAction SilentlyContinue',
    '',
  ].join('\n');
}

export function buildGitApplyCommand(diffs: readonly FileDiff[], platform = ''): GitApplyCommandPayload | null {
  const { included, skipped } = collectGitApplyPatches(diffs);
  if (included.length === 0) return null;
  const patch = included.map((entry) => entry.rawPatch).join('\n');
  return {
    command: platform === 'win32' ? buildPowerShellGitApplyCommand(patch) : buildPosixGitApplyCommand(patch),
    included,
    skipped,
  };
}

export function canCopyGitApplyCommand(diffs: readonly FileDiff[]): boolean {
  return buildGitApplyCommand(diffs) !== null;
}

export function getGitApplyCopyAvailability(
  diffs: readonly FileDiff[],
  hideWhitespace: boolean,
  platform = '',
): GitApplyCopyAvailability {
  if (hideWhitespace) return { canCopy: false, reason: 'hide-whitespace' };
  const payload = buildGitApplyCommand(diffs, platform);
  return payload ? { canCopy: true, payload } : { canCopy: false, reason: 'empty' };
}
