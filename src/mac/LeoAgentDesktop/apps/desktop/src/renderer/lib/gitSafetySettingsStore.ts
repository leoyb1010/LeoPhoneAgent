/**
 * gitSafetySettingsStore — renderer mirror for Git safety settings.
 *
 * Source of truth is main's <userData>/git-safety-settings.json. localStorage
 * is only a synchronous renderer mirror so message rows can decide whether to
 * show the Codex rewind entry without async work during render.
 */

const STORAGE_KEY = 'gitSafety.autoSnapshotEnabled';

type Subscriber = (value: boolean) => void;
const subscribers = new Set<Subscriber>();

export function getGitSafetyAutoSnapshotEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setGitSafetyAutoSnapshotEnabled(next: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, next ? 'true' : 'false');
  } catch {
    // localStorage unavailable — ignore; callers still get main IPC errors.
  }
  subscribers.forEach((cb) => cb(next));
}

export function subscribeGitSafetyAutoSnapshotEnabled(cb: Subscriber): () => void {
  subscribers.add(cb);

  const storageHandler = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    cb(getGitSafetyAutoSnapshotEnabled());
  };
  window.addEventListener('storage', storageHandler);

  return () => {
    subscribers.delete(cb);
    window.removeEventListener('storage', storageHandler);
  };
}

export async function bootstrapGitSafetySettingsFromMain(): Promise<void> {
  try {
    const settings = await window.electronAPI.maker.gitSafetyGet();
    if (getGitSafetyAutoSnapshotEnabled() === settings.autoSnapshotEnabled) return;
    setGitSafetyAutoSnapshotEnabled(settings.autoSnapshotEnabled);
  } catch {
    // preload unavailable / IPC failed — keep local fallback.
  }
}
