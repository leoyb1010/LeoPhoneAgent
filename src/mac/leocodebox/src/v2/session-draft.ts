export const DRAFTS_KEY = 'leo2.drafts';
export const DRAFT_TEXT_MAX = 20_000;
export const DRAFT_KEYS_MAX = 40;

export function clipDraftText(text: string, limit = DRAFT_TEXT_MAX): string {
  const clean = text.replace(/\u0000/g, '');
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}\n…(后面还有 ${clean.length - limit} 字)`;
}

export function readPersistedDrafts(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key.includes(':') || typeof value !== 'string') continue;
      const text = clipDraftText(value);
      if (text.trim()) next[key] = text;
    }
    return next;
  } catch {
    return {};
  }
}

export function writePersistedDrafts(drafts: Record<string, string>): string {
  const entries = Object.entries(drafts)
    .map(([key, value]) => [key, clipDraftText(value)] as const)
    .filter(([key, value]) => key.includes(':') && value.trim());
  return JSON.stringify(Object.fromEntries(entries.slice(-DRAFT_KEYS_MAX)));
}
