export type AuditCategory = 'all' | 'tool' | 'error' | 'permission';
export type ReplayMessage = Record<string, unknown>;

export function messageText(message: ReplayMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
        return (item as { text: string }).text;
      }
      return JSON.stringify(item);
    }).join('\n');
  }
  if (content !== undefined) return JSON.stringify(content);
  return JSON.stringify(message);
}

export function matchesCategory(message: ReplayMessage, category: AuditCategory): boolean {
  if (category === 'all') return true;
  const serialized = JSON.stringify(message).toLowerCase();
  if (category === 'tool') return /tool[_-]?(use|call|result)|function[_-]?call/.test(serialized);
  if (category === 'error') return /\berror\b|failed|exception|stacktrace/.test(serialized);
  return /permission|approval|consent|allow|deny/.test(serialized);
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker));
  return results;
}
