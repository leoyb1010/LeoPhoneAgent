import { common, UIAbility } from '@kit.AbilityKit';
import { pushCommon, pushService } from '@kit.PushKit';
import { http } from '@kit.NetworkKit';
import { gatewayStore } from '../store/GatewayStore';
import { requireHttpsRoot } from '../net/Protocol';

export class PushRegistrar {
  static token: string = '';
  static error: string = '';
  static registered: boolean = false;
  static channelEnabled: boolean = false;
  private static revision: number = 0;
  private static attached: boolean = false;

  /** Call once from UIAbility.onCreate. Payloads only identify a destination, never authorize actions. */
  static attach(ability: UIAbility): void {
    if (PushRegistrar.attached) {
      return;
    }
    PushRegistrar.attached = true;
    pushService.on('tokenUpdate', ability, (token: string) => {
      PushRegistrar.register(ability.context, token).catch(() => {});
    });
    pushService.receiveMessage('BACKGROUND', ability, (payload: pushCommon.PushPayload) => {
      PushRegistrar.receive(payload);
    });
  }

  static detach(): void {
    pushService.off('tokenUpdate');
    PushRegistrar.attached = false;
    PushRegistrar.revision++;
  }

  static async bind(context: common.UIAbilityContext): Promise<void> {
    try {
      const token = await pushService.getToken();
      await PushRegistrar.register(context, token);
    } catch (_err) {
      PushRegistrar.error = '无法登记推送，请检查 AGC 配置、中继连接和通知权限';
      PushRegistrar.registered = false;
      PushRegistrar.channelEnabled = false;
    }
  }

  private static async register(context: common.Context, token: string): Promise<void> {
    const revision = ++PushRegistrar.revision;
    PushRegistrar.token = token;
    PushRegistrar.registered = false;
    PushRegistrar.channelEnabled = false;
    if (!token || token.length > 4096 || /[\r\n]/.test(token)) {
      throw new Error('invalid push token');
    }
    await gatewayStore.ensureLoaded(context);
    const root = requireHttpsRoot(gatewayStore.apiRoot);
    const key = gatewayStore.key;
    if (key.length < 16) {
      throw new Error('missing relay key');
    }
    const request = http.createHttp();
    try {
      const response = await request.request(root + '/device', {
        method: http.RequestMethod.POST,
        header: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        extraData: JSON.stringify({ platform: 'harmony', kind: 'device', token: token,
          bundle_id: 'com.leoyuan.leophoneagent.harmony', environment: 'production' }),
        connectTimeout: 12000, readTimeout: 12000, maxRedirects: 0, usingCache: false
      });
      if (revision !== PushRegistrar.revision || root !== gatewayStore.apiRoot || key !== gatewayStore.key) {
        return;
      }
      if (response.responseCode < 200 || response.responseCode >= 300) {
        throw new Error('push registration rejected');
      }
      const reply = JSON.parse(`${response.result}`) as Record<string, Object>;
      if (reply['ok'] !== true) {
        throw new Error('push registration failed');
      }
      const channel = reply['harmony'] as Record<string, Object> | undefined;
      PushRegistrar.registered = true;
      PushRegistrar.channelEnabled = channel !== undefined && channel['enabled'] === true;
      PushRegistrar.error = '';
    } finally {
      request.destroy();
    }
  }

  private static receive(payload: pushCommon.PushPayload): void {
    if (payload.data.length > 16384) {
      return;
    }
    try {
      const outer = JSON.parse(payload.data) as Record<string, Object>;
      const data = typeof outer['data'] === 'string' ?
        JSON.parse(outer['data'] as string) as Record<string, Object> : outer;
      const session = `${data['session_id'] ?? ''}`;
      const machine = `${data['machine'] ?? ''}`;
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(session) || !/^[A-Za-z0-9_.-]{1,80}$/.test(machine)) {
        return;
      }
      // The foreground router must re-fetch the actual session and pending approval from its configured relay.
      AppStorage.setOrCreate('pushRemoteSession', session);
      AppStorage.setOrCreate('pushRemoteMachine', machine);
      AppStorage.setOrCreate('pushRemoteTick', (AppStorage.get<number>('pushRemoteTick') ?? 0) + 1);
    } catch (_err) {
      // Malformed notifications are ignored without exposing payload contents in logs.
    }
  }

  static line(): string {
    if (PushRegistrar.error) {
      return PushRegistrar.error;
    }
    if (PushRegistrar.channelEnabled) {
      return '已登记华为推送通道，实际送达请用真机测试';
    }
    if (PushRegistrar.registered) {
      return '设备已登记，中继尚未启用华为推送通道';
    }
    return PushRegistrar.token ? '已获取设备令牌，尚未完成中继登记' : '尚未获取推送令牌';
  }
}
