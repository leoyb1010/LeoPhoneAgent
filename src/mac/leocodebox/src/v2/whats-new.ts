export type ReleaseNoteLike = { version: string; date: string; items: string[] };

export const WHATS_NEW_SEEN_KEY = 'leo.releaseNotes.lastSeenVersion';

export function shouldShowWhatsNewFor(version: string, getItem: (key: string) => string | null): boolean {
  if (!version) return false;
  try {
    return getItem(WHATS_NEW_SEEN_KEY) !== version;
  } catch {
    return false;
  }
}

export function markWhatsNewSeenFor(version: string, setItem: (key: string, value: string) => void): void {
  if (!version) return;
  try {
    setItem(WHATS_NEW_SEEN_KEY, version);
  } catch {
    // 隐私模式写不了,不影响功能
  }
}

/** 当前版本必须对上自己的条目。对不上绝不拿上一版顶上。 */
export function releaseNoteForVersion(notes: readonly ReleaseNoteLike[], version: string): ReleaseNoteLike | null {
  const exact = notes.find((note) => note.version === version);
  if (exact) return exact;
  if (!version) return notes[0] ?? null;
  return {
    version,
    date: '',
    items: [`本版本(${version})的更新说明缺失 —— 发版时漏了 LEO_RELEASE_NOTES 条目,请补上。`],
  };
}
