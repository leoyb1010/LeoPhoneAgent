function normFile(file?: string | null): string {
  return String(file ?? '').trim();
}

function draftWorthKeeping(peek?: string | null, draft?: string | null): string | null {
  if (draft == null) return null;
  const text = String(peek ?? '');
  if (!text || text === '正在读…' || text.startsWith('读不了:')) return null;
  if (draft === text) return null;
  return draft;
}

function peekIsLoading(peek?: string | null): boolean {
  const text = String(peek ?? '');
  return !text || text === '正在读…' || text.startsWith('读不了:');
}

export function writePeekFileDraft(
  bag: Map<string, Map<string, string>>,
  sessionKey: string,
  file?: string | null,
  peek?: string | null,
  draft?: string | null,
): void {
  if (!sessionKey) return;
  const name = normFile(file);
  if (!name) return;
  if (peekIsLoading(peek)) return;
  let inner = bag.get(sessionKey);
  if (!inner) {
    inner = new Map();
    bag.set(sessionKey, inner);
  }
  const keep = draftWorthKeeping(peek, draft);
  if (keep == null) inner.delete(name);
  else inner.set(name, keep);
  if (inner.size === 0) bag.delete(sessionKey);
}

export function peekFileDraftToRestore(
  bag: Map<string, Map<string, string>>,
  sessionKey: string,
  file?: string | null,
): string | null {
  const name = normFile(file);
  if (!sessionKey || !name) return null;
  return bag.get(sessionKey)?.get(name) ?? null;
}

export function clearPeekFileDraft(
  bag: Map<string, Map<string, string>>,
  sessionKey: string,
  file?: string | null,
): void {
  writePeekFileDraft(bag, sessionKey, file, 'ok', 'ok');
}
