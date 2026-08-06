/**
 * Converts selected parsed diff lines back into an apply-able unified patch.
 *
 * The selection key is the parser's original line index inside each hunk. That
 * keeps renderer layout concerns out of the patch contract.
 */

import type { DiffLine, DiffSelection, FileDiff, Hunk } from './types.js';

const NO_NEWLINE_MARKER = '\\ No newline at end of file';

export class PatchFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchFormatError';
  }
}

interface FormattedHunk {
  header: string;
  lines: string[];
}

function escapeGitPathChar(char: string): string {
  switch (char) {
    case '\t':
      return '\\t';
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\b':
      return '\\b';
    case '\f':
      return '\\f';
    case '"':
      return '\\"';
    case '\\':
      return '\\\\';
    default:
      return char;
  }
}

function needsGitPathQuoting(gitPath: string): boolean {
  return Array.from(gitPath).some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f || char === '"' || char === '\\';
  });
}

export function quoteGitPatchPath(gitPath: string): string {
  if (!needsGitPathQuoting(gitPath)) return gitPath;
  return `"${Array.from(gitPath, escapeGitPathChar).join('')}"`;
}

function formatPath(prefix: 'a' | 'b', gitPath: string): string {
  return quoteGitPatchPath(`${prefix}/${gitPath}`);
}

function lineWasSelected(line: DiffLine, selected: ReadonlySet<number>): boolean {
  return line.selectable && selected.has(line.index);
}

function isFullySelected(diff: FileDiff, selection: DiffSelection): boolean {
  const selectedByHunk = new Map(selection.lines.map((item) => [item.hunkIndex, new Set(item.lineIndices)]));
  for (const hunk of diff.hunks) {
    const selected = selectedByHunk.get(hunk.index) ?? new Set<number>();
    for (const lineIndex of hunk.selectableLines) {
      if (!selected.has(lineIndex)) return false;
    }
  }
  return diff.hunks.some((hunk) => hunk.selectableLines.length > 0);
}

function selectedSetForHunk(selection: DiffSelection, hunk: Hunk): ReadonlySet<number> {
  return new Set(selection.lines.find((item) => item.hunkIndex === hunk.index)?.lineIndices ?? []);
}

function formatIncludedLine(line: DiffLine, selected: ReadonlySet<number>): string | null {
  if (line.type === 'context') return line.raw;
  if (line.type === 'add') return lineWasSelected(line, selected) ? line.raw : null;
  if (lineWasSelected(line, selected)) return line.raw;
  return ` ${line.content}`;
}

function lineContributesOld(formatted: string): boolean {
  return formatted[0] === ' ' || formatted[0] === '-';
}

function lineContributesNew(formatted: string): boolean {
  return formatted[0] === ' ' || formatted[0] === '+';
}

function formatHunk(hunk: Hunk, selected: ReadonlySet<number>): FormattedHunk | null {
  if (!hunk.lines.some((line) => lineWasSelected(line, selected))) return null;

  const lines: string[] = [];
  let oldLines = 0;
  let newLines = 0;
  for (const line of hunk.lines) {
    const formatted = formatIncludedLine(line, selected);
    if (formatted === null) continue;
    lines.push(formatted);
    if (lineContributesOld(formatted)) oldLines += 1;
    if (lineContributesNew(formatted)) newLines += 1;
    if (line.noTrailingNewLine) lines.push(NO_NEWLINE_MARKER);
  }

  if (!lines.some((line) => line.startsWith('+') || line.startsWith('-'))) return null;
  const section = hunk.section ? ` ${hunk.section}` : '';
  return {
    header: `@@ -${hunk.oldStart},${oldLines} +${hunk.newStart},${newLines} @@${section}`,
    lines,
  };
}

function buildPatchHeader(diff: FileDiff, fullSelection: boolean): string[] {
  const oldPath = diff.status === 'renamed' || diff.status === 'copied'
    ? diff.oldPath ?? diff.path
    : diff.path;
  const lines = [`diff --git ${formatPath('a', oldPath)} ${formatPath('b', diff.path)}`];
  const oldMode = diff.mode.old;
  const newMode = diff.mode.new ?? diff.mode.old ?? '100644';
  const oldOid = diff.index.oldOid;
  const newOid = diff.index.newOid;

  if (diff.status === 'added' || diff.status === 'untracked') {
    lines.push(`new file mode ${newMode}`);
    if (oldOid || newOid) lines.push(`index ${oldOid ?? '0000000'}..${newOid ?? '0000000'}`);
    lines.push('--- /dev/null', `+++ ${formatPath('b', diff.path)}`);
    return lines;
  }

  if (diff.status === 'deleted' && fullSelection) {
    if (oldMode) lines.push(`deleted file mode ${oldMode}`);
    if (oldOid || newOid) lines.push(`index ${oldOid ?? '0000000'}..${newOid ?? '0000000'}`);
    lines.push(`--- ${formatPath('a', oldPath)}`, '+++ /dev/null');
    return lines;
  }

  if (oldOid || newOid) {
    const mode = oldMode && oldMode === newMode ? ` ${oldMode}` : '';
    lines.push(`index ${oldOid ?? '0000000'}..${newOid ?? '0000000'}${mode}`);
  }
  lines.push(`--- ${formatPath('a', oldPath)}`, `+++ ${formatPath('b', diff.path)}`);
  return lines;
}

export function formatPatchForSelection(diff: FileDiff, selection: DiffSelection): string {
  const hunks = diff.hunks
    .map((hunk) => formatHunk(hunk, selectedSetForHunk(selection, hunk)))
    .filter((hunk): hunk is FormattedHunk => Boolean(hunk));
  if (hunks.length === 0) throw new PatchFormatError('empty patch selection');

  const lines = buildPatchHeader(diff, isFullySelected(diff, selection));
  for (const hunk of hunks) {
    lines.push(hunk.header, ...hunk.lines);
  }
  return `${lines.join('\n')}\n`;
}
