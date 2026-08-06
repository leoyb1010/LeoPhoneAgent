const STORAGE_KEY = 'silentEncryptedRetry.enabled';

type Subscriber = (value: boolean) => void;
const subscribers = new Set<Subscriber>();

export function getSilentEncryptedRetryEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setSilentEncryptedRetryEnabled(next: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, next ? 'true' : 'false');
  } catch {
    // Keep in-memory subscribers updated even when localStorage is unavailable.
  }
  subscribers.forEach((cb) => cb(next));
}

export function subscribeSilentEncryptedRetryEnabled(cb: Subscriber): () => void {
  subscribers.add(cb);
  const storageHandler = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    cb(getSilentEncryptedRetryEnabled());
  };
  window.addEventListener('storage', storageHandler);

  return () => {
    subscribers.delete(cb);
    window.removeEventListener('storage', storageHandler);
  };
}

export async function bootstrapSilentEncryptedRetryFromMain(): Promise<void> {
  try {
    const settings = await window.electronAPI.maker.silentEncryptedRetryGet();
    if (getSilentEncryptedRetryEnabled() === settings.enabled) return;
    setSilentEncryptedRetryEnabled(settings.enabled);
  } catch {
    // Leave the existing renderer mirror in place.
  }
}
