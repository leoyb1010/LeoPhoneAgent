import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';

/** External agents require a local opt-in, independent of full-auto chat approval. */
export class AgentSettings {
  static async enabled(context: common.Context): Promise<boolean> {
    const store = await preferences.getPreferences(context, 'leo.harmony.system');
    return await store.get('a2aEnabled', false) === true;
  }

  static async setEnabled(context: common.Context, value: boolean): Promise<void> {
    const store = await preferences.getPreferences(context, 'leo.harmony.system');
    await store.put('a2aEnabled', value);
    await store.flush();
  }
}
