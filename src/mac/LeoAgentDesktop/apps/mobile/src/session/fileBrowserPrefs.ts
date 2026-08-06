/**
 * 文件浏览的视图/排序偏好,按 workdir 记忆(标题 ⌄ 菜单切换,规则:配置的
 * 用户 override 与默认值分离——未显式改过的 workdir 始终跟随系统默认)。
 * 内存 Map 同步读 + AsyncStorage 异步持久化,模式对齐 composerDraftStore。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { FileBrowserSortMode, FileBrowserViewMode } from '@/session/fileBrowserGrid';

const STORAGE_KEY_PREFIX = 'xdt.fileBrowserPrefs.v1';

export interface FileBrowserPrefs {
  view: FileBrowserViewMode;
  sort: FileBrowserSortMode;
}

export const DEFAULT_FILE_BROWSER_PREFS: FileBrowserPrefs = { view: 'grid', sort: 'name' };

const memory = new Map<string, FileBrowserPrefs>();

function storageKey(workdir: string): string {
  return `${STORAGE_KEY_PREFIX}.${encodeURIComponent(workdir)}`;
}

export function readFileBrowserPrefsSync(workdir: string): FileBrowserPrefs {
  return memory.get(workdir) ?? DEFAULT_FILE_BROWSER_PREFS;
}

export async function readFileBrowserPrefs(workdir: string): Promise<FileBrowserPrefs> {
  const cached = memory.get(workdir);
  if (cached) return cached;
  const raw = await AsyncStorage.getItem(storageKey(workdir)).catch(() => null);
  if (!raw) return DEFAULT_FILE_BROWSER_PREFS;
  try {
    const parsed = JSON.parse(raw) as Partial<FileBrowserPrefs>;
    const prefs: FileBrowserPrefs = {
      view: parsed.view === 'list' ? 'list' : 'grid',
      sort: parsed.sort === 'mtime' || parsed.sort === 'size' ? parsed.sort : 'name',
    };
    memory.set(workdir, prefs);
    return prefs;
  } catch {
    return DEFAULT_FILE_BROWSER_PREFS;
  }
}

export function saveFileBrowserPrefs(workdir: string, prefs: FileBrowserPrefs): void {
  if (!workdir) return;
  memory.set(workdir, prefs);
  void AsyncStorage.setItem(storageKey(workdir), JSON.stringify(prefs)).catch(() => undefined);
}
