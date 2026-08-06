/**
 * expandedStore — workdir → expanded folder set persistence (localStorage).
 *
 * Why module-level + localStorage rather than module-level only:
 *   Survives reload / dev restart / app restart. User's expectation when
 *   navigating away from /cc-agent/files/* and coming back is "my folders
 *   are still where I left them" regardless of what triggered the unmount.
 *
 * Storage shape:
 *   {
 *     "<workdir absolute path>": ["Assets", "Assets/Scripts", "Design"],
 *     ...
 *   }
 *
 * Cap: max 200 paths per workdir (defends against runaway state if a user
 * mass-expands a deep tree); 100 workdirs total in the bag (LRU evict the
 * oldest workdir keys to keep storage bounded). 200 paths × ~80 chars ×
 * 100 workdirs ≈ 1.6 MB worst case — well under localStorage's 5 MB quota.
 */

const STORAGE_KEY = 'cc-agent.workdirBrowse.expandedFolders.v1';
const MAX_PATHS_PER_WORKDIR = 200;
const MAX_WORKDIRS = 100;

type Bag = Record<string, string[]>;

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
    // Cap workdir count: drop the lexicographically-smallest keys until
    // we're under the limit. Lexicographic isn't true LRU but localStorage
    // doesn't track access time and we don't want to maintain a separate
    // recency index for this. The eviction is rare enough not to matter.
    const keys = Object.keys(bag);
    if (keys.length > MAX_WORKDIRS) {
      const evict = keys.sort().slice(0, keys.length - MAX_WORKDIRS);
      for (const k of evict) delete bag[k];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bag));
  } catch {
    // localStorage full / disabled — degrade silently. The in-memory state
    // for this session still works; user just loses persistence across
    // restart.
  }
}

export function loadExpandedSet(workdir: string): Set<string> {
  const bag = loadBag();
  const list = bag[workdir];
  if (!Array.isArray(list)) return new Set();
  return new Set(list.filter((s): s is string => typeof s === 'string'));
}

export function saveExpandedSet(workdir: string, expanded: Set<string>): void {
  const bag = loadBag();
  const list = [...expanded];
  // Filter out the empty-string root key (always implicit) + dedupe.
  const filtered = list.filter((p) => p !== '');
  if (filtered.length === 0) {
    // Don't keep empty entries in the bag — it'd just bloat over time.
    delete bag[workdir];
  } else {
    bag[workdir] = filtered.slice(0, MAX_PATHS_PER_WORKDIR);
  }
  saveBag(bag);
}
