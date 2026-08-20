import { common } from '@kit.AbilityKit';
import { pushService } from '@kit.PushKit';

export class PushRegistrar {
  static token: string = '';
  static error: string = '';

  static async bind(_context: common.UIAbilityContext): Promise<void> {
    try {
      PushRegistrar.token = await pushService.getToken();
      PushRegistrar.error = '';
    } catch (err) {
      PushRegistrar.token = '';
      PushRegistrar.error = `${err}`;
    }
  }

  static line(): string {
    if (PushRegistrar.token.length > 0) {
      const tail = PushRegistrar.token.length > 12 ?
        PushRegistrar.token.substring(PushRegistrar.token.length - 12) : PushRegistrar.token;
      return `Push token …${tail}`;
    }
    if (PushRegistrar.error.length > 0) {
      return `Push 还没拿到：${PushRegistrar.error}`;
    }
    return '还没向 Push Kit 要 token';
  }
}
