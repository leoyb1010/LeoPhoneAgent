import { http } from '@kit.NetworkKit';
import {
  DEVICE_GRANT,
  DeviceAuth,
  KIMI_CLIENT_ID,
  KIMI_DEVICE_URL,
  KIMI_TOKEN_URL,
  XAI_CLIENT_ID,
  XAI_DISCOVERY,
  accessTokenFromJson,
  classifyDevicePoll,
  hostEndsWith,
  httpsHost,
  parseDeviceAuth
} from './LocalProtocol';
import { InAppBrowser } from './InAppBrowser';
import { OAuthSession } from './OAuthSession';

export class DeviceOAuth {
  private static xaiDeviceUrl: string = '';
  private static xaiTokenCached: string = '';
  private static waitGen: number = 0;

  static cancelWait(): void {
    DeviceOAuth.waitGen += 1;
  }

  static async start(type: string): Promise<DeviceAuth> {
    if (type === 'kimiCode') {
      return DeviceOAuth.request(KIMI_DEVICE_URL, `client_id=${encodeURIComponent(KIMI_CLIENT_ID)}`);
    }
    if (type === 'xAI') {
      await DeviceOAuth.discoverXai();
      const url = DeviceOAuth.xaiDeviceUrl;
      if (!DeviceOAuth.xaiHost(url)) {
        throw new Error('xAI 发现接口不是 *.x.ai');
      }
      const body = `client_id=${encodeURIComponent(XAI_CLIENT_ID)}&scope=${encodeURIComponent('openid profile email offline_access grok-cli:access api:access')}`;
      return DeviceOAuth.request(url, body);
    }
    throw new Error('这一家还没有设备码登录');
  }

  static async wait(type: string, auth: DeviceAuth): Promise<string> {
    const mine = DeviceOAuth.waitGen;
    const tokenUrl = type === 'xAI' ? await DeviceOAuth.xaiTokenUrl() : KIMI_TOKEN_URL;
    const client = type === 'xAI' ? XAI_CLIENT_ID : KIMI_CLIENT_ID;
    let waitMs = auth.interval * 1000;
    const deadline = Date.now() + auth.expiresIn * 1000;
    const form = `grant_type=${encodeURIComponent(DEVICE_GRANT)}&device_code=${encodeURIComponent(auth.deviceCode)}&client_id=${encodeURIComponent(client)}`;
    while (Date.now() < deadline) {
      await DeviceOAuth.sleep(waitMs);
      if (mine !== DeviceOAuth.waitGen) {
        throw new Error('已取消登录');
      }
      const pair = await DeviceOAuth.post(tokenUrl, form);
      const kind = classifyDevicePoll(pair.json, pair.ok);
      if (kind === 'ok') {
        const token = accessTokenFromJson(pair.json);
        if (token.length === 0) {
          throw new Error('没有 access_token');
        }
        OAuthSession.stash(pair.json, type, tokenUrl);
        return token;
      }
      if (kind === 'pending') {
        continue;
      }
      if (kind === 'slow') {
        waitMs += 5000;
        continue;
      }
      if (kind === 'denied') {
        throw new Error('你拒绝了登录');
      }
      if (kind === 'expired') {
        throw new Error('设备码过期，再开一次');
      }
      throw new Error(DeviceOAuth.pollError(pair.json));
    }
    throw new Error('登录超时');
  }

  static open(auth: DeviceAuth): string {
    return InAppBrowser.open(auth.verificationUri);
  }

  private static async discoverXai(): Promise<void> {
    if (DeviceOAuth.xaiDeviceUrl.length > 0 && DeviceOAuth.xaiTokenCached.length > 0) {
      return;
    }
    const discovery = await DeviceOAuth.getJson(XAI_DISCOVERY);
    const deviceUrl = `${(discovery as Record<string, Object>)['device_authorization_endpoint'] ?? ''}`;
    const tokenUrl = `${(discovery as Record<string, Object>)['token_endpoint'] ?? ''}`;
    if (!DeviceOAuth.xaiHost(deviceUrl) || !DeviceOAuth.xaiHost(tokenUrl)) {
      throw new Error('xAI 发现接口不是 *.x.ai');
    }
    DeviceOAuth.xaiDeviceUrl = deviceUrl;
    DeviceOAuth.xaiTokenCached = tokenUrl;
  }

  private static async xaiTokenUrl(): Promise<string> {
    await DeviceOAuth.discoverXai();
    return DeviceOAuth.xaiTokenCached;
  }

  private static xaiHost(url: string): boolean {
    return hostEndsWith(httpsHost(url), 'x.ai');
  }

  private static pollError(json: object): string {
    const obj = json as Record<string, Object>;
    const text = `${obj['error_description'] ?? obj['error'] ?? ''}`.trim();
    return text.length > 0 ? text : '登录失败';
  }

  private static async request(url: string, body: string): Promise<DeviceAuth> {
    const pair = await DeviceOAuth.post(url, body);
    const auth = parseDeviceAuth(pair.json);
    if (!auth) {
      throw new Error(DeviceOAuth.pollError(pair.json));
    }
    return auth;
  }

  private static async getJson(url: string): Promise<object> {
    const req = http.createHttp();
    try {
      const resp = await req.request(url, {
        method: http.RequestMethod.GET,
        connectTimeout: 20000,
        readTimeout: 20000
      });
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        throw new Error(`http ${resp.responseCode}`);
      }
      return JSON.parse(`${resp.result}`) as object;
    } finally {
      req.destroy();
    }
  }

  private static async post(url: string, body: string): Promise<HttpPair> {
    const req = http.createHttp();
    try {
      const resp = await req.request(url, {
        method: http.RequestMethod.POST,
        header: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        extraData: body,
        connectTimeout: 20000,
        readTimeout: 20000
      });
      const pair = new HttpPair();
      pair.ok = resp.responseCode >= 200 && resp.responseCode < 300;
      try {
        pair.json = JSON.parse(`${resp.result}`) as object;
      } catch (_err) {
        pair.json = JSON.parse('{}') as object;
      }
      return pair;
    } finally {
      req.destroy();
    }
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve: Function) => {
      setTimeout(() => {
        resolve();
      }, ms);
    });
  }
}

class HttpPair {
  ok: boolean = false;
  json: object = JSON.parse('{}') as object;
}
