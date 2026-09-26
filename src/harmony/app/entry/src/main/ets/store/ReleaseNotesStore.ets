import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { ReleaseCatalog } from '../release/ReleaseCatalog';

const STORE = 'leo.harmony.release';
const KEY = 'last_seen_version';

export class ReleaseNotesStore {
  static async shouldShow(context: common.Context): Promise<boolean> {
    const store = await preferences.getPreferences(context, STORE);
    const seen = await store.get(KEY, '') as string;
    return seen !== ReleaseCatalog.currentVersion;
  }

  static async markSeen(context: common.Context): Promise<void> {
    const store = await preferences.getPreferences(context, STORE);
    await store.put(KEY, ReleaseCatalog.currentVersion);
    await store.flush();
  }
}
