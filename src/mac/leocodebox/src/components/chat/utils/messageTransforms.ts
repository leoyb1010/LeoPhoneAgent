export interface DiffLine {
  type: 'added' | 'removed';
  content: string;
  lineNum: number;
}

export type DiffCalculator = (oldStr: string, newStr: string) => DiffLine[];

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

// ponytail: LCS table is O(n·m). 800² ints is fine; a 10k-line Edit allocates
// ~400M cells and throws `Invalid array length` / OOM, which used to blank the
// whole chat ErrorBoundary. Ceiling + prefix/suffix dump is the upgrade path
// if we ever need Myers.
const MAX_LCS_LINES = 800;
const MAX_LCS_CELLS = MAX_LCS_LINES * MAX_LCS_LINES;
const CACHE_INLINE_CHARS = 50_000;

function fallbackLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1;
  }
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const diffLines: DiffLine[] = [];
  for (let i = start; i <= oldEnd; i += 1) {
    diffLines.push({ type: 'removed', content: oldLines[i], lineNum: i + 1 });
  }
  for (let i = start; i <= newEnd; i += 1) {
    diffLines.push({ type: 'added', content: newLines[i], lineNum: i + 1 });
  }
  return diffLines;
}

function splitLines(value: unknown): string[] {
  const text = asText(value);
  return text === '' ? [] : text.split('\n');
}

export const calculateDiff = (oldStr: string, newStr: string): DiffLine[] => {
  const oldLines = splitLines(oldStr);
  const newLines = splitLines(newStr);

  if (
    oldLines.length > MAX_LCS_LINES
    || newLines.length > MAX_LCS_LINES
    || oldLines.length * newLines.length > MAX_LCS_CELLS
  ) {
    return fallbackLineDiff(oldLines, newLines);
  }

  // Use LCS alignment so insertions/deletions don't cascade into a full-file "changed" diff.
  const lcsTable: number[][] = Array.from({ length: oldLines.length + 1 }, () =>
    new Array<number>(newLines.length + 1).fill(0),
  );
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      if (oldLines[oldIndex] === newLines[newIndex]) {
        lcsTable[oldIndex][newIndex] = lcsTable[oldIndex + 1][newIndex + 1] + 1;
      } else {
        lcsTable[oldIndex][newIndex] = Math.max(
          lcsTable[oldIndex + 1][newIndex],
          lcsTable[oldIndex][newIndex + 1],
        );
      }
    }
  }

  const diffLines: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    const oldLine = oldLines[oldIndex];
    const newLine = newLines[newIndex];

    if (oldLine === newLine) {
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    if (lcsTable[oldIndex + 1][newIndex] >= lcsTable[oldIndex][newIndex + 1]) {
      diffLines.push({ type: 'removed', content: oldLine, lineNum: oldIndex + 1 });
      oldIndex += 1;
      continue;
    }

    diffLines.push({ type: 'added', content: newLine, lineNum: newIndex + 1 });
    newIndex += 1;
  }

  while (oldIndex < oldLines.length) {
    diffLines.push({ type: 'removed', content: oldLines[oldIndex], lineNum: oldIndex + 1 });
    oldIndex += 1;
  }

  while (newIndex < newLines.length) {
    diffLines.push({ type: 'added', content: newLines[newIndex], lineNum: newIndex + 1 });
    newIndex += 1;
  }

  return diffLines;
};

export const createCachedDiffCalculator = (): DiffCalculator => {
  const cache = new Map<string, DiffLine[]>();

  return (oldStr: string, newStr: string) => {
    const oldText = asText(oldStr);
    const newText = asText(newStr);
    // Don't stringify whole files as Map keys — large Edit/Write payloads
    // used to allocate a second copy of both buffers on every render.
    if (oldText.length + newText.length > CACHE_INLINE_CHARS) {
      return calculateDiff(oldText, newText);
    }
    const key = `${oldText.length}\0${newText.length}\0${oldText}\0${newText}`;
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }

    const calculated = calculateDiff(oldText, newText);
    cache.set(key, calculated);
    if (cache.size > 100) {
      const firstKey = cache.keys().next().value;
      if (firstKey) {
        cache.delete(firstKey);
      }
    }
    return calculated;
  };
};
