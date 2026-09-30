import { asset } from '@kit.AssetStoreKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';

const RELAY_ALIAS = 'leo.harmony.relay_key';
const PROVIDER_ALIAS = 'leo.harmony.provider_key';
/** OAuth 续期档案的别名前缀。OAuthSession 写、ProviderStore 删，别名只在这里定义一次。 */
export const OAUTH_ALIAS = 'leo.harmony.oauth';

export class SecretStore {
  static async writeKey(value: string): Promise<void> {
    await SecretStore.write(RELAY_ALIAS, value);
  }

  static async readKey(): Promise<string> {
    return SecretStore.read(RELAY_ALIAS);
  }

  static async writeProviderKey(value: string): Promise<void> {
    await SecretStore.write(PROVIDER_ALIAS, value);
  }

  static async readProviderKey(): Promise<string> {
    return SecretStore.read(PROVIDER_ALIAS);
  }

  static async writeProviderKeyFor(id: string, value: string): Promise<void> {
    await SecretStore.write(`${PROVIDER_ALIAS}.${id}`, value);
  }

  static async readProviderKeyFor(id: string): Promise<string> {
    // 原来这里在读不到 per-instance 密钥时会回落到全局 PROVIDER_ALIAS。
    // 后果是：任何还没写过自己密钥的实例都会拿到那把旧钥匙，configured() 判定为「已配好」，
    // 然后把 A 家的 API Key 发到 B 家的接口上。回落已删除；
    // 老档案的接管改由 ProviderStore.adoptLegacyKey 显式做一次，做完就把全局别名清掉。
    return SecretStore.read(`${PROVIDER_ALIAS}.${id}`);
  }

  static async removeProviderKeyFor(id: string): Promise<void> {
    await SecretStore.remove(`${PROVIDER_ALIAS}.${id}`);
  }

  static async removeProviderKey(): Promise<void> {
    await SecretStore.remove(PROVIDER_ALIAS);
  }

  static async write(alias: string, value: string): Promise<void> {
    const aliasBytes = SecretStore.bytes(alias);
    const addMap: asset.AssetMap = new Map();
    addMap.set(asset.Tag.ALIAS, aliasBytes);
    addMap.set(asset.Tag.SECRET, SecretStore.bytes(value));
    addMap.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_FIRST_UNLOCKED);
    try {
      await asset.add(addMap);
    } catch (_err) {
      const query: asset.AssetMap = new Map();
      query.set(asset.Tag.ALIAS, aliasBytes);
      const updateMap: asset.AssetMap = new Map();
      updateMap.set(asset.Tag.SECRET, SecretStore.bytes(value));
      await asset.update(query, updateMap);
    }
  }

  static async read(alias: string): Promise<string> {
    const query: asset.AssetMap = new Map();
    query.set(asset.Tag.ALIAS, SecretStore.bytes(alias));
    query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
    try {
      const result = await asset.query(query);
      // 原生 query 对不存在的别名抛 NOT_FOUND；空/不完整结果也不能当成可迁移的空值。
      if (result.length !== 1) throw new Error('凭据查询结果不完整，请重试');
      const secret = result[0].get(asset.Tag.SECRET);
      if (!(secret instanceof Uint8Array)) throw new Error('凭据暂不可读，请重试');
      return SecretStore.text(secret);
    } catch (error) {
      // 只有确定不存在才是空值；锁屏、服务/IPC/数据库错误不能触发空凭据迁移或清理。
      if ((error as BusinessError).code === asset.ErrorCode.NOT_FOUND) return '';
      throw error;
    }
  }

  static async remove(alias: string): Promise<void> {
    const query: asset.AssetMap = new Map();
    query.set(asset.Tag.ALIAS, SecretStore.bytes(alias));
    try {
      await asset.remove(query);
    } catch (_err) {
      // 本来就不存在时忽略
    }
  }

  private static bytes(text: string): Uint8Array {
    return new util.TextEncoder().encodeInto(text);
  }

  private static text(raw: Uint8Array): string {
    return util.TextDecoder.create('utf-8', { ignoreBOM: true }).decodeToString(raw);
  }
}
