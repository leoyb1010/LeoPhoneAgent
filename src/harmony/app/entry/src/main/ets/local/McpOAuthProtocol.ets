import { url } from '@kit.ArkTS';

export class McpOAuthConfig {
  mode: string = 'static';
  issuer: string = '';
  authorizationEndpoint: string = '';
  tokenEndpoint: string = '';
  registrationEndpoint: string = '';
  clientId: string = '';
  redirectURI: string = 'leobot://mcp/oauth/callback';
  scopes: string = '';
}
export class McpOAuthTokens {
  clientSecret: string = '';
  accessToken: string = '';
  refreshToken: string = '';
  expiresAt: number = 0;
}
export function oauthHTTPS(raw: string): url.URL {
  if (!raw || raw.length > 4096 || /[\r\n\u0000]/.test(raw)) { throw new Error('OAuth地址无效'); }
  const value = new url.URL(raw.trim());
  if (value.protocol !== 'https:' || !value.hostname || value.username || value.password || value.hash) { throw new Error('OAuth网络端点必须是无用户凭据的HTTPS地址'); }
  const credentialNames = ['apikey', 'accesskey', 'secretkey', 'authkey', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'clientsecret', 'secret', 'password', 'passwd', 'authorization', 'auth', 'key'];
  let credential = false;
  value.searchParams.forEach((_entry: string, rawName: string) => {
    let name = rawName;
    for (let pass = 0; pass < 2 && /%[0-9A-Fa-f]{2}/.test(name); pass++) { try { name = decodeURIComponent(name); } catch (_err) { break; } }
    name = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (credentialNames.includes(name) || ['apikey', 'accesskey', 'secretkey', 'token', 'secret', 'signature', 'credential'].some((suffix: string) => name.endsWith(suffix))) { credential = true; }
  });
  if (credential) { throw new Error('OAuth地址含查询凭据，请先将MCP查询凭据改到请求头后重新授权'); }
  return value;
}
export function oauthResource(raw: string): string {
  if (!raw || raw.length > 4096 || /[\r\n\u0000]/.test(raw)) { throw new Error('MCP资源地址无效'); }
  const configured = new url.URL(raw); configured.hash = '';
  return oauthHTTPS(configured.toString()).toString();
}
export function oauthIssuer(raw: string): string {
  const value = oauthHTTPS(raw);
  if (value.search) { throw new Error('OAuth issuer不能包含查询参数'); }
  return value.toString();
}
export function oauthMetadataCandidates(raw: string, resource: boolean): string[] {
  const value = oauthHTTPS(raw); const path = value.pathname === '/' ? '' : value.pathname.replace(/\/$/, '');
  const result = [value.origin + '/.well-known/' + (resource ? 'oauth-protected-resource' : 'oauth-authorization-server') + path];
  if (resource) { if (path) { result.push(value.origin + '/.well-known/oauth-protected-resource'); } }
  else {
    result.push(value.origin + '/.well-known/openid-configuration' + path);
    if (path) { result.push(value.origin + path + '/.well-known/openid-configuration'); }
  }
  return result.filter((entry: string, index: number) => result.indexOf(entry) === index).map((entry: string) => entry + (resource ? value.search : ''));
}
export function oauthServerMetadata(raw: Record<string, Object>, expectedIssuer: string): McpOAuthConfig {
  if (oauthIssuer(`${raw['issuer'] ?? ''}`) !== oauthIssuer(expectedIssuer)) { throw new Error('OAuth签发者与资源声明不一致'); }
  const result = new McpOAuthConfig(); result.issuer = oauthIssuer(expectedIssuer);
  result.authorizationEndpoint = oauthHTTPS(`${raw['authorization_endpoint'] ?? ''}`).toString();
  result.tokenEndpoint = oauthHTTPS(`${raw['token_endpoint'] ?? ''}`).toString();
  if (raw['registration_endpoint']) { result.registrationEndpoint = oauthHTTPS(`${raw['registration_endpoint']}`).toString(); }
  const methods = raw['code_challenge_methods_supported'];
  if (!Array.isArray(methods) || !(methods as Object[]).some((method: Object) => method === 'S256')) { throw new Error('OAuth签发者未声明PKCE S256支持'); }
  return result;
}
export function oauthRedirect(raw: string): url.URL {
  const value = new url.URL(raw);
  if (value.username || value.password || value.search || value.hash) { throw new Error('OAuth回调地址格式无效'); }
  const loopback = value.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(value.hostname) && Number(value.port) > 0;
  const scheme = ['leobot:', 'lobe:', 'leophoneagent:'].includes(value.protocol) && value.hostname === 'mcp' && value.pathname === '/oauth/callback';
  const legacy = value.protocol === 'leophoneagent-mcp:' && value.hostname === 'oauth' && value.pathname === '/callback';
  if (!loopback && !scheme && !legacy) { throw new Error('OAuth回调只支持本机loopback或LeoBot专用回调'); }
  return value;
}
export function oauthOwnedCallback(callback: string, redirect: string, state: string): boolean {
  if (callback.length > 32768 || /[\r\n\u0000]/.test(callback)) { return false; }
  try {
    const expected = oauthRedirect(redirect); const value = new url.URL(callback);
    return !value.username && !value.password && value.protocol === expected.protocol && value.hostname === expected.hostname && value.port === expected.port &&
      value.pathname === expected.pathname && !value.hash && value.searchParams.getAll('state').length === 1 && value.searchParams.get('state') === state && state.length > 0;
  } catch (_err) { return false; }
}
export function oauthCallback(callback: string, redirect: string, state: string): string {
  if (!oauthOwnedCallback(callback, redirect, state)) { throw new Error('OAuth回调归属或state校验失败'); }
  const value = new url.URL(callback); const search = value.searchParams;
  if (search.get('error')) { throw new Error('授权被取消或拒绝'); }
  if (search.getAll('code').length !== 1) { throw new Error('OAuth授权码数量无效'); }
  const code = search.get('code') ?? '';
  if (!code || code.length > 16384 || /[\r\n\u0000]/.test(code)) { throw new Error('OAuth授权码无效'); }
  return code;
}
export function oauthForm(values: Record<string, string>): string {
  return Object.keys(values).map((name: string) => encodeURIComponent(name) + '=' + encodeURIComponent(values[name])).join('&');
}
export function oauthTokenReply(raw: Record<string, Object>, clientSecret: string, previousRefresh: string = ''): McpOAuthTokens {
  const result = new McpOAuthTokens(); result.clientSecret = clientSecret;
  if (typeof raw['access_token'] !== 'string' || (raw['refresh_token'] !== undefined && typeof raw['refresh_token'] !== 'string') ||
    (raw['token_type'] !== undefined && typeof raw['token_type'] !== 'string') ||
    (raw['expires_in'] !== undefined && typeof raw['expires_in'] !== 'number' && !(typeof raw['expires_in'] === 'string' && /^\d+$/.test(raw['expires_in'] as string)))) { throw new Error('OAuth令牌响应字段类型无效'); }
  result.accessToken = raw['access_token'] as string;
  result.refreshToken = raw['refresh_token'] === undefined ? previousRefresh : raw['refresh_token'] as string;
  const tokenType = `${raw['token_type'] ?? 'Bearer'}`;
  const duration = Number(raw['expires_in'] ?? 0);
  if (!result.accessToken || result.accessToken.length > 65536 || result.refreshToken.length > 65536 ||
    /[\r\n\u0000]/.test(result.accessToken + result.refreshToken) || tokenType.toLowerCase() !== 'bearer' || !Number.isFinite(duration) || duration < 0) {
    throw new Error('OAuth令牌响应无效');
  }
  result.expiresAt = duration > 0 ? Date.now() + Math.min(duration, 365 * 86400) * 1000 : 0;
  return result;
}
