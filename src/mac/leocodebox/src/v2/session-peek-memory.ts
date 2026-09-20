export type PeekMemory = { file: string; draft?: string | null };

export function peekMemoryKey(machine?: string | null, id?: string | null): string {
  if (!machine || !id) return '';
  return `${machine}:${id}`;
}

export function peekMemoryToSave(input: {
  file?: string | null;
  peek?: string | null;
  draft?: string | null;
}): PeekMemory | null {
  const file = String(input.file ?? '').trim();
  if (!file) return null;
  const peek = input.peek ?? '';
  if (!peek || peek === '正在读…' || peek.startsWith('读不了:')) return { file };
  if (input.draft != null && input.draft !== peek) return { file, draft: input.draft };
  return { file };
}

export function peekMemoryFile(mem?: PeekMemory | null): string | null {
  const file = String(mem?.file ?? '').trim();
  return file || null;
}

export function writePeekMemory(
  map: Map<string, PeekMemory>,
  key: string,
  live: { file?: string | null; peek?: string | null; draft?: string | null },
): void {
  if (!key) return;
  const saved = peekMemoryToSave(live);
  if (saved) map.set(key, saved);
}

export function peekDraftToRestore(
  mem?: PeekMemory | null,
  file?: string | null,
): string | null {
  const want = String(file ?? '').trim();
  if (!want || peekMemoryFile(mem) !== want) return null;
  const draft = mem?.draft;
  return draft == null ? null : draft;
}
