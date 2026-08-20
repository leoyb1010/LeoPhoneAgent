import { http } from '@kit.NetworkKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';
import { OAuthSession } from './OAuthSession';

export class BrowserOAuth {
  private static type: string = '';
  private static verifier: string = '';
  private static state: string = '';
  private static waitGen: number = 0;
  private static resolveUrl: Function | null = null;

  static cancel(): void {
    BrowserOAuth.waitGen += 1;
    const fn = BrowserOAuth.resolveUrl;
    BrowserOAuth.resolveUrl = null;
    if (fn) {
      fn('');
    }
  }

  static async begin(type: string): Promise<string> {
    BrowserOAuth.cancel();
    const pair = await BrowserOAuth.pkce(type === 'openAI' ? 64 : 96);
    BrowserOAuth.type = type;
    BrowserOAuth.verifier = pair.verifier;
    BrowserOAuth.state = await BrowserOAuth.randomUrl(32);
    return BrowserOAuth.authUrl(type, pair.challenge, BrowserOAuth.state);
  }

  static waitCapture(): Promise<string> {
    const mine = BrowserOAuth.waitGen;
    return new Promise<string>((resolve: Function) => {
      BrowserOAuth.resolveUrl = (url: string): void => {
        if (mine !== BrowserOAuth.waitGen) {
          resolve('');
          return;
        }
        resolve(url);
      };
    });
  }

  static take(url: string): boolean {
    if (!BrowserOAuth.isCallback(url, BrowserOAuth.type)) {
      return false;
    }
    const fn = BrowserOAuth.resolveUrl;
    BrowserOAuth.resolveUrl = null;
    if (fn) {
      fn(url);
    }
    return true;
  }

  static async exchange(type: string, callbackUrl: string): Promise<string> {
    if (callbackUrl.length === 0) {
      throw new Error('已取消登录');
    }
    const code = BrowserOAuth.codeFrom(callbackUrl, BrowserOAuth.state);
    if (type === 'openRouter') {
      return BrowserOAuth.exchangeOpenRouter(code);
    }
    if (type === 'anthropic') {
      return BrowserOAuth.exchangeAnthropic(code);
    }
    if (type === 'openAI') {
      return BrowserOAuth.exchangeOpenAI(code);
    }
    throw new Error('这一家没有浏览器 OAuth');
  }

  static available(type: string): string[] {
    if (type === 'xAI' || type === 'kimiCode') {
      return ['oauth', 'apiKey'];
    }
    if (type === 'openAI' || type === 'anthropic' || type === 'openRouter') {
      return ['apiKey', 'oauth'];
    }
    return ['apiKey'];
  }

  static oauthHint(type: string): string {
    if (type === 'anthropic') {
      return '用 Claude 账号登录';
    }
    if (type === 'openAI') {
      return '用 OpenAI Codex 登录';
    }
    if (type === 'openRouter') {
      return '用 OpenRouter 登录';
    }
    if (type === 'xAI') {
      return '用 xAI 登录（要 SuperGrok 或 X Premium+）';
    }
    if (type === 'kimiCode') {
      return '用 Kimi Coding Plan 登录';
    }
    return '';
  }

  static keyHint(type: string): string {
    if (type === 'openAI') {
      return '官方 API 和兼容第三方根';
    }
    if (type === 'anthropic') {
      return 'Anthropic 控制台的 API Key';
    }
    if (type === 'gemini') {
      return 'Google Gemini 的 API Key';
    }
    if (type === 'openRouter') {
      return 'OpenRouter 控制台的 API Key';
    }
    if (type === 'xAI') {
      return 'xAI Console 的 API Key（api.x.ai）';
    }
    if (type === 'kimiCode') {
      return 'Moonshot 账号的 API Key';
    }
    return '自己填钥匙';
  }

  static signInLabel(type: string): string {
    if (type === 'anthropic') {
      return '用 Claude 登录';
    }
    if (type === 'openAI') {
      return '用 OpenAI 登录';
    }
    if (type === 'openRouter') {
      return '用 OpenRouter 登录';
    }
    if (type === 'xAI') {
      return '用 xAI 登录';
    }
    if (type === 'kimiCode') {
      return '用 Kimi Code 登录';
    }
    return 'OAuth 登录';
  }

  static methodLabel(type: string): string {
    return BrowserOAuth.available(type).indexOf('oauth') >= 0 ? 'OAuth / API Key' : '仅 API Key';
  }

  static needsProxy(type: string): boolean {
    return type === 'openAI' || type === 'anthropic' || type === 'xAI' || type === 'gemini';
  }

  static networkHint(type: string): string {
    if (type === 'openAI') {
      return 'OpenAI 登录页在 auth.openai.com，大陆直连通常打不开，需要可访问境外的网络或代理。';
    }
    if (type === 'anthropic') {
      return 'Claude 登录页在 claude.ai，大陆直连通常打不开，需要可访问境外的网络或代理。';
    }
    if (type === 'xAI') {
      return 'xAI 登录页在 auth.x.ai，大陆直连通常打不开，需要可访问境外的网络或代理。';
    }
    if (type === 'gemini') {
      return 'Gemini 接口在 generativelanguage.googleapis.com，大陆直连通常不通。';
    }
    if (type === 'openRouter') {
      return 'OpenRouter 通常可直连。打不开时复制链接换网络再试。';
    }
    if (type === 'kimiCode') {
      return 'Kimi 登录一般可直连。按页上的设备码在网页确认即可。';
    }
    return '';
  }

  static canRefresh(type: string): boolean {
    return type === 'openAI' || type === 'anthropic' || type === 'kimiCode' || type === 'xAI';
  }

  static refreshUrl(type: string, tokenUrl: string = ''): string {
    if (type === 'openAI') {
      return 'https://auth.openai.com/oauth/token';
    }
    if (type === 'anthropic') {
      return 'https://console.anthropic.com/v1/oauth/token';
    }
    if (type === 'kimiCode') {
      return 'https://auth.kimi.com/api/oauth/token';
    }
    if (type === 'xAI') {
      return tokenUrl;
    }
    return '';
  }

  static refreshClientId(type: string): string {
    if (type === 'openAI') {
      return 'app_EMoamEEZ73f0CkXaXp7hrann';
    }
    if (type === 'anthropic') {
      return '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
    }
    if (type === 'kimiCode') {
      return '17e5f671-d194-4dfb-9706-5516cb48c098';
    }
    if (type === 'xAI') {
      return 'b1a00492-073a-47ea-816f-4c329264a828';
    }
    return '';
  }

  static refreshUsesForm(type: string): boolean {
    return type === 'kimiCode' || type === 'xAI';
  }

  static regionBlocked(code: string, info: string): boolean {
    const blob = `${code} ${info}`.toLowerCase();
    return blob.indexOf('403') >= 0 || blob.indexOf('unsupported_country') >= 0 ||
      blob.indexOf('unsupported_region') >= 0 || blob.indexOf('request_forbidden') >= 0;
  }

  static webErrorCopy(code: string, info: string, type: string = ''): string {
    if (BrowserOAuth.regionBlocked(code, info) &&
      (type === 'openAI' || type === 'anthropic' || type === 'xAI' || type.length === 0)) {
      const who = type === 'anthropic' ? 'Claude' : type === 'xAI' ? 'xAI' : 'OpenAI';
      return `${who} 判定当前地区不可用。大陆直连时登录页会白屏或甩一串英文 JSON。打开可访问境外的网络后再进本页，或复制链接换网络打开。授权成功后仍要回到本页才能收码。`;
    }
    const detail = `${code} ${info}`.trim();
    const head = detail.length > 0 ? `页面打不开：${detail}` : '页面打不开';
    return `${head}。检查网络或代理，也可复制链接用系统浏览器看。授权回调仍要回到本页才能收码。`;
  }

  static isCallback(url: string, type: string): boolean {
    const port = BrowserOAuth.port(type);
    if (port <= 0) {
      return false;
    }
    const path = BrowserOAuth.path(type).toLowerCase();
    const lower = url.trim().toLowerCase();
    const noHash = lower.split('#')[0];
    if (noHash.indexOf(path) < 0) {
      return false;
    }
    return noHash.indexOf(`localhost:${port}`) >= 0 || noHash.indexOf(`127.0.0.1:${port}`) >= 0;
  }

  private static port(type: string): number {
    if (type === 'openRouter') {
      return 3000;
    }
    if (type === 'anthropic') {
      return 54545;
    }
    if (type === 'openAI') {
      return 1455;
    }
    return 0;
  }

  private static path(type: string): string {
    return type === 'openAI' ? '/auth/callback' : '/callback';
  }

  private static redirect(type: string): string {
    const port = BrowserOAuth.port(type);
    if (port <= 0) {
      return '';
    }
    return `http://localhost:${port}${BrowserOAuth.path(type)}`;
  }

  private static authUrl(type: string, challenge: string, state: string): string {
    const redirect = encodeURIComponent(BrowserOAuth.redirect(type));
    const encodedState = encodeURIComponent(state);
    const encodedChallenge = encodeURIComponent(challenge);
    if (type === 'openRouter') {
      return `https://openrouter.ai/auth?callback_url=${redirect}&code_challenge=${encodedChallenge}&code_challenge_method=S256&state=${encodedState}`;
    }
    if (type === 'anthropic') {
      return `https://claude.ai/oauth/authorize?client_id=${encodeURIComponent('9d1c250a-e61b-44d9-88ed-5944d1962f5e')}&redirect_uri=${redirect}&response_type=code&scope=${encodeURIComponent('org:create_api_key user:profile user:inference')}&state=${encodedState}&code_challenge=${encodedChallenge}&code_challenge_method=S256`;
    }
    if (type === 'openAI') {
      return `https://auth.openai.com/oauth/authorize?client_id=${encodeURIComponent('app_EMoamEEZ73f0CkXaXp7hrann')}&redirect_uri=${redirect}&response_type=code&scope=${encodeURIComponent('openid profile email offline_access')}&state=${encodedState}&code_challenge=${encodedChallenge}&code_challenge_method=S256&codex_cli_simplified_flow=true&originator=codex_cli_rs&id_token_add_organizations=true`;
    }
    throw new Error('这一家没有浏览器 OAuth');
  }

  private static codeFrom(url: string, expectedState: string): string {
    const err = BrowserOAuth.query(url, 'error_description') || BrowserOAuth.query(url, 'error');
    if (err.length > 0) {
      throw new Error(err);
    }
    const state = BrowserOAuth.query(url, 'state');
    if (expectedState.length > 0 && state !== expectedState) {
      throw new Error('OAuth state 对不上');
    }
    const code = BrowserOAuth.query(url, 'code');
    if (code.length === 0) {
      throw new Error('没有授权码');
    }
    return code;
  }

  private static query(url: string, key: string): string {
    const cut = url.indexOf('?');
    if (cut < 0) {
      return '';
    }
    const search = url.substring(cut + 1).split('#')[0];
    const pairs = search.split('&');
    const prefix = `${key}=`;
    for (let i = 0; i < pairs.length; i++) {
      if (pairs[i].startsWith(prefix)) {
        return decodeURIComponent(pairs[i].substring(prefix.length).replace(/\+/g, ' '));
      }
    }
    return '';
  }

  private static async exchangeOpenRouter(code: string): Promise<string> {
    const body = `{"code":${JSON.stringify(code)},"code_verifier":${JSON.stringify(BrowserOAuth.verifier)},"code_challenge_method":"S256"}`;
    const json = await BrowserOAuth.postJson('https://openrouter.ai/api/v1/auth/keys', body, {
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/leoyb1010/LeoPhoneAgent',
      'X-Title': 'LeoPhoneAgent'
    });
    const key = `${(json as Record<string, Object>)['key'] ?? ''}`;
    if (key.length === 0) {
      throw new Error('OpenRouter 没有返回 key');
    }
    return key;
  }

  private static async exchangeAnthropic(code: string): Promise<string> {
    const body = `{"grant_type":"authorization_code","client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e","code":${JSON.stringify(code)},"redirect_uri":${JSON.stringify(BrowserOAuth.redirect('anthropic'))},"code_verifier":${JSON.stringify(BrowserOAuth.verifier)},"state":${JSON.stringify(BrowserOAuth.state)}}`;
    const json = await BrowserOAuth.postJson('https://console.anthropic.com/v1/oauth/token', body, {
      'Content-Type': 'application/json'
    });
    OAuthSession.stash(json, 'anthropic');
    return BrowserOAuth.requireAccess(json);
  }

  private static async exchangeOpenAI(code: string): Promise<string> {
    const body = `{"grant_type":"authorization_code","client_id":"app_EMoamEEZ73f0CkXaXp7hrann","code":${JSON.stringify(code)},"redirect_uri":${JSON.stringify(BrowserOAuth.redirect('openAI'))},"code_verifier":${JSON.stringify(BrowserOAuth.verifier)}}`;
    const json = await BrowserOAuth.postJson('https://auth.openai.com/oauth/token', body, {
      'Content-Type': 'application/json'
    });
    OAuthSession.stash(json, 'openAI');
    return BrowserOAuth.requireAccess(json);
  }

  private static requireAccess(json: object): string {
    const token = `${(json as Record<string, Object>)['access_token'] ?? ''}`;
    if (token.length === 0) {
      throw new Error('没有 access_token');
    }
    return token;
  }

  private static async postJson(url: string, body: string, header: Record<string, string>): Promise<object> {
    const req = http.createHttp();
    try {
      const resp = await req.request(url, {
        method: http.RequestMethod.POST,
        header: header,
        extraData: body,
        connectTimeout: 20000,
        readTimeout: 20000
      });
      let json: object = JSON.parse('{}') as object;
      try {
        json = JSON.parse(`${resp.result}`) as object;
      } catch (_err) {
        json = JSON.parse('{}') as object;
      }
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        const obj = json as Record<string, Object>;
        const text = `${obj['error_description'] ?? obj['error'] ?? obj['message'] ?? ''}`.trim();
        throw new Error(text.length > 0 ? text : `http ${resp.responseCode}`);
      }
      return json;
    } finally {
      req.destroy();
    }
  }

  private static async pkce(bytes: number): Promise<PkcePair> {
    const verifier = await BrowserOAuth.randomUrl(bytes);
    const md = cryptoFramework.createMd('SHA256');
    await md.update({ data: BrowserOAuth.ascii(verifier) });
    const digest = await md.digest();
    const pair = new PkcePair();
    pair.verifier = verifier;
    pair.challenge = BrowserOAuth.base64Url(digest.data);
    return pair;
  }

  private static async randomUrl(bytes: number): Promise<string> {
    const random = cryptoFramework.createRandom();
    const blob = await random.generateRandom(bytes);
    return BrowserOAuth.base64Url(blob.data);
  }

  private static ascii(text: string): Uint8Array {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      out[i] = text.charCodeAt(i) & 0xff;
    }
    return out;
  }

  private static base64Url(bytes: Uint8Array): string {
    const helper = new util.Base64Helper();
    return helper.encodeToStringSync(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
}

class PkcePair {
  verifier: string = '';
  challenge: string = '';
}
