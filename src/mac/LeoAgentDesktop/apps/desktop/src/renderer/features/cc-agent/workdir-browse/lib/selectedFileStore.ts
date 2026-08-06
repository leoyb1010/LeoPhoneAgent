/**
 * selectedFileStore — per-workdir "last opened file" persistence.
 *
 * Why URL search param `?file=` isn't enough:
 *   When the user navigates away from /cc-agent/files/:sessionId (e.g. back
 *   to a regular session, or to /skillhub) and later returns via the
 *   sidebar's file-text button, the URL is reset to the bare route — the
 *   `?file=` they were viewing is gone. localStorage gets us "last open
 *   file" continuity across that navigation.
 *
 * Storage shape:
 *   {
 *     "<workdir>": "Assets/Scripts/Engine/AssetService.cs",
 *     ...
 *   }
 *
 * Cap: 100 workdirs (LRU evict on save). Each entry is a single string so
 * total bag size is well within localStorage quota.
 */

const STORAGE_KEY = 'cc-agent.workdirBrowse.selectedFile.v1';
const MAX_WORKDIRS = 100;

type Bag = Record<string, string>;

function loadBag(): Bag {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Bag;
    }
    return {};
  } catch {
    return {};
  }
}

function saveBag(bag: Bag): void {
  try {
    const keys = Object.keys(bag);
    if (keys.length > MAX_WORKDIRS) {
      const evict = keys.sort().slice(0, keys.length - MAX_WORKDIRS);
      for (const k of evict) delete bag[k];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bag));
  } catch {
    // localStorage full / disabled — degrade silently.
  }
}

export function loadSelectedFile(workdir: string): string | null {
  const bag = loadBag();
  const v = bag[workdir];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function saveSelectedFile(workdir: string, relPath: string | null): void {
  const bag = loadBag();
  if (!relPath) {
    delete bag[workdir];
  } else {
    bag[workdir] = relPath;
  }
  saveBag(bag);
}
