import { util } from '@kit.ArkTS';
import { SecretStore } from './SecretStore';

class SecretGeneration {
  binding: string = '';
  value: string = '';
}

/** JSON 只提交不可变凭据代号；失败写者永远不覆盖另一代的钥匙。 */
export class BoundSecret {
  static async stage(binding: string, value: string): Promise<string> {
    const ref = 'leo.harmony.generation.' + util.generateRandomUUID(false);
    const body = new SecretGeneration();
    body.binding = binding;
    body.value = value;
    await SecretStore.write(ref, JSON.stringify(body));
    return ref;
  }

  static valid(ref: string): boolean {
    return /^leo\.harmony\.generation\.[A-Za-z0-9-]+$/.test(ref);
  }

  static async read(ref: string, binding: string): Promise<string> {
    if (!BoundSecret.valid(ref)) return '';
    const raw = await SecretStore.read(ref);
    if (!raw) throw new Error('此代凭据暂不可读，请重新加载后重试；原凭据已保留');
    try {
      const body = JSON.parse(raw) as Record<string, Object>;
      return body['binding'] === binding && typeof body['value'] === 'string' ? `${body['value']}` : '';
    } catch (_err) { return ''; }
  }

  static async retire(ref: string): Promise<void> {
    if (BoundSecret.valid(ref)) await SecretStore.remove(ref);
  }
}
