import { http } from '@kit.NetworkKit';
import { accountIdFromIdToken } from './LocalProtocol';
import { BrowserOAuth } from './BrowserOAuth';
import { OAUTH_ALIAS, SecretStore } from '../store/SecretStore';
import { providerStore } from '../store/ProviderStore';

const ALIAS = OAUTH_ALIAS;

export class OAuthToken {
  access: string = '';
  account: string = '';
}

/** 同一个实例两次主动刷新之间的最小间隔 */
const MIN_REFRESH_GAP_MS = 5 * 60 * 1000;

export class OAuthSession {
  private static lastAttempt: Map<string, number> = new Map();
  static lastRefresh: string = '';
  static lastAccount: string = '';
  static lastExpire: number = 0;
  static lastType: string = '';
  static lastTokenUrl: string = '';

  static stash(json: object, type: string = 'openAI', tokenUrl: string = ''): void {
    const obj = json as Record<string, Object>;
    OAuthSession.lastRefresh = `${obj['refresh_token'] ?? ''}`;
    const expires = Number(obj['expires_in'] ?? 0);
    OAuthSession.lastExpire = expires > 0 ? Date.now() + expires * 1000 : 0;
    OAuthSession.lastAccount = accountIdFromIdToken(`${obj['id_token'] ?? ''}`);
    OAuthSession.lastType = type;
    OAuthSession.lastTokenUrl = tokenUrl;
  }

  static async bind(instanceId: string): Promise<void> {
    if (OAuthSession.lastRefresh.length === 0 && OAuthSession.lastAccount.length === 0) {
      return;
    }
    await SecretStore.write(`${ALIAS}.${instanceId}`,
      `{"refresh":${JSON.stringify(OAuthSession.lastRefresh)},"account":${JSON.stringify(OAuthSession.lastAccount)},"expire":${OAuthSession.lastExpire},"type":${JSON.stringify(OAuthSession.lastType)},"tokenUrl":${JSON.stringify(OAuthSession.lastTokenUrl)}}`);
    OAuthSession.lastRefresh = '';
    OAuthSession.lastAccount = '';
    OAuthSession.lastExpire = 0;
    OAuthSession.lastType = '';
    OAuthSession.lastTokenUrl = '';
  }

  static async ensure(instanceId: string, access: string, type: string = 'openAI'): Promise<OAuthToken> {
    const out = new OAuthToken();
    out.access = access;
    const raw = await SecretStore.read(`${ALIAS}.${instanceId}`);
    let refresh = '';
    let expire = 0;
    let storedType = type;
    let tokenUrl = '';
    if (raw.length > 0) {
      try {
        const obj = JSON.parse(raw) as Record<string, Object>;
        refresh = `${obj['refresh'] ?? ''}`;
        out.account = `${obj['account'] ?? ''}`;
        expire = Number(obj['expire'] ?? 0);
        storedType = `${obj['type'] ?? type}` || type;
        tokenUrl = `${obj['tokenUrl'] ?? ''}`;
      } catch (_err) {
        refresh = '';
      }
    }
    if (refresh.length === 0 || (expire > 0 && expire - 5 * 60 * 1000 > Date.now())) {
      return out;
    }
    if (!BrowserOAuth.canRefresh(storedType)) {
      return out;
    }
    // ensure() 每一轮模型调用都会走（工具循环里每一轮也算一次）。
    // 上游没返回 expires_in 时 expire 恒为 0，上面那个「还没过期」的条件永远不成立，
    // 于是每一轮都真的去打一次 token 端点 —— 对会轮换 refresh_token 的家还有把令牌刷坏的风险。
    // 这里加一个按实例的最小刷新间隔兜底。
    const lastTry = OAuthSession.lastAttempt.get(instanceId) ?? 0;
    if (Date.now() - lastTry < MIN_REFRESH_GAP_MS) {
      return out;
    }
    OAuthSession.lastAttempt.set(instanceId, Date.now());
    try {
      const json = await OAuthSession.refresh(storedType, refresh, tokenUrl);
      const token = `${(json as Record<string, Object>)['access_token'] ?? ''}`;
      if (token.length === 0) {
        return out;
      }
      out.access = token;
      const nextRefresh = `${(json as Record<string, Object>)['refresh_token'] ?? refresh}`;
      const expires = Number((json as Record<string, Object>)['expires_in'] ?? 0);
      const nextExpire = expires > 0 ? Date.now() + expires * 1000 : expire;
      const account = accountIdFromIdToken(`${(json as Record<string, Object>)['id_token'] ?? ''}`);
      if (account.length > 0) {
        out.account = account;
      }
      await SecretStore.writeProviderKeyFor(instanceId, token);
      providerStore.rememberKey(instanceId, token);
      await SecretStore.write(`${ALIAS}.${instanceId}`,
        `{"refresh":${JSON.stringify(nextRefresh)},"account":${JSON.stringify(out.account)},"expire":${nextExpire},"type":${JSON.stringify(storedType)},"tokenUrl":${JSON.stringify(tokenUrl)}}`);
    } catch (_err) {
      // keep the stored access token
    }
    return out;
  }

  private static async refresh(type: string, refresh: string, tokenUrl: string): Promise<object> {
    const url = BrowserOAuth.refreshUrl(type, tokenUrl);
    if (url.length === 0) {
      throw new Error('没有刷新地址');
    }
    const client = BrowserOAuth.refreshClientId(type);
    const req = http.createHttp();
    try {
      const form = BrowserOAuth.refreshUsesForm(type);
      const body = form ?
        `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh)}&client_id=${encodeURIComponent(client)}` :
        `{"grant_type":"refresh_token","client_id":${JSON.stringify(client)},"refresh_token":${JSON.stringify(refresh)}}`;
      const resp = await req.request(url, {
        method: http.RequestMethod.POST,
        header: {
          'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
          'Accept': 'application/json'
        },
        extraData: body,
        connectTimeout: 20000,
        readTimeout: 20000
      });
      const json = JSON.parse(`${resp.result}`) as object;
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        throw new Error(`http ${resp.responseCode}`);
      }
      return json;
    } finally {
      req.destroy();
    }
  }
}
