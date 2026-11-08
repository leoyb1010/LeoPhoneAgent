import { common } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { url, util } from '@kit.ArkTS';
import { McpOAuthConfig, McpOAuthTokens, oauthCallback, oauthForm, oauthHTTPS, oauthIssuer, oauthMetadataCandidates, oauthOwnedCallback, oauthRedirect, oauthResource, oauthServerMetadata, oauthTokenReply } from './McpOAuthProtocol';
import { McpOAuthLoopback } from './McpOAuthLoopback';
import { McpOAuthNetwork } from './McpOAuthNetwork';
import { McpOAuthRecord, McpOAuthStore } from './McpOAuthStore';

export class McpOAuthAuthorization {
  header: string = '';
  record: McpOAuthRecord = new McpOAuthRecord();
}
class McpRefreshLease { current: () => boolean = () => true; }
class McpRefreshWork {
  leases: Set<McpRefreshLease> = new Set();
  promise: Promise<McpOAuthAuthorization> = Promise.resolve(new McpOAuthAuthorization());
}
export class McpOAuthSession {
  readonly label: string;
  readonly resource: string;
  readonly network: McpOAuthNetwork = new McpOAuthNetwork();
  config: McpOAuthConfig;
  authorizationURL: string = '';
  phase: string = 'preparing';
  onComplete: () => void = () => {};
  onError: (message: string) => void = () => {};
  private state: string = '';
  private verifier: string = '';
  private clientSecret: string = '';
  private revision: string = '';
  private loopback: McpOAuthLoopback = new McpOAuthLoopback();
  private callerCurrent: () => boolean;

  constructor(label: string, resource: string, config: McpOAuthConfig, clientSecret: string, isCurrent: () => boolean) {
    this.label = label; this.resource = oauthResource(resource);
    this.config = JSON.parse(JSON.stringify(config)) as McpOAuthConfig;
    this.clientSecret = clientSecret; this.callerCurrent = isCurrent;
  }
  current(): boolean { return !['cancelled', 'complete'].includes(this.phase) && this.callerCurrent() && McpOAuth.active(this); }
  private check(): void { if (!this.current()) { throw new Error('MCP OAuth授权已取消或目标已改变'); } }

  async prepare(): Promise<void> {
    this.check();
    const previous = McpOAuthStore.read(this.label);
    this.revision = previous?.revision ?? '';
    const priorTokens = previous && previous.resource === this.resource ? await McpOAuthStore.tokens(previous) : new McpOAuthTokens();
    this.check();
    this.config = await this.resolveConfig(); this.check();
    oauthRedirect(this.config.redirectURI);
    if (!this.clientSecret && previous && McpOAuthStore.binding(previous) === this.binding()) { this.clientSecret = priorTokens.clientSecret; }
    const current = McpOAuthStore.read(this.label);
    if ((current?.revision ?? '') !== this.revision) { throw new Error('MCP OAuth配置已改变'); }
    const proposed = new McpOAuthRecord(); proposed.label = this.label; proposed.resource = this.resource; proposed.config = this.config;
    if (!current || McpOAuthStore.binding(current) !== McpOAuthStore.binding(proposed)) {
      proposed.enabled = false; proposed.revision = util.generateRandomUUID(true);
      const registration = new McpOAuthTokens(); registration.clientSecret = this.clientSecret;
      const saved = await McpOAuthStore.commit(proposed, registration, this.revision, null, () => this.current());
      this.revision = saved.revision;
    }
    this.check();
    const random = cryptoFramework.createRandom();
    const verifier = (await random.generateRandom(64)).data; this.check();
    const state = (await random.generateRandom(32)).data; this.check();
    this.verifier = McpOAuth.base64URL(verifier); this.state = McpOAuth.base64URL(state);
    const hash = cryptoFramework.createMd('SHA256'); await hash.update({ data: new util.TextEncoder().encodeInto(this.verifier) });
    const challenge = McpOAuth.base64URL((await hash.digest()).data); this.check();
    const endpoint = oauthHTTPS(this.config.authorizationEndpoint);
    endpoint.searchParams.set('response_type', 'code'); endpoint.searchParams.set('client_id', this.config.clientId);
    endpoint.searchParams.set('redirect_uri', this.config.redirectURI); endpoint.searchParams.set('code_challenge', challenge);
    endpoint.searchParams.set('code_challenge_method', 'S256'); endpoint.searchParams.set('state', this.state);
    endpoint.searchParams.set('resource', this.resource);
    if (this.config.scopes.trim()) { endpoint.searchParams.set('scope', this.config.scopes.trim()); }
    this.authorizationURL = endpoint.toString(); this.phase = 'ready';
    await this.loopback.start(this.config.redirectURI, (callback: string) => this.accepts(callback), (callback: string) => {
      this.consume(callback).catch(() => {});
    });
    this.check();
  }
  private binding(): string {
    const record = new McpOAuthRecord(); record.label = this.label; record.resource = this.resource; record.config = this.config;
    return McpOAuthStore.binding(record);
  }
  private async resolveConfig(): Promise<McpOAuthConfig> {
    const config = this.config;
    if (config.clientId && config.authorizationEndpoint && config.tokenEndpoint) {
      config.authorizationEndpoint = oauthHTTPS(config.authorizationEndpoint).toString();
      config.tokenEndpoint = oauthHTTPS(config.tokenEndpoint).toString();
      config.issuer = oauthIssuer(config.issuer || oauthHTTPS(config.authorizationEndpoint).origin);
      return config;
    }
    let issuers: string[] = []; let suggestedScopes: string[] = [];
    for (const candidate of oauthMetadataCandidates(this.resource, true)) {
      const reply = await this.network.json(candidate, http.RequestMethod.GET, '', 'application/json', () => this.current()); this.check();
      if (reply.code === 404) { continue; }
      if (reply.code !== 200) { throw new Error('MCP资源授权元数据暂不可用，请稍后重试'); }
      if (reply.value['resource'] && oauthResource(`${reply.value['resource']}`) !== this.resource) { throw new Error('OAuth资源元数据不属于此MCP地址'); }
      const list = reply.value['authorization_servers'];
      if (!Array.isArray(list) || list.length === 0 || list.length > 16) { throw new Error('MCP资源没有提供有效签发者'); }
      issuers = list.map((issuer: Object) => oauthIssuer(`${issuer}`));
      const scopes = reply.value['scopes_supported'];
      if (Array.isArray(scopes)) { suggestedScopes = scopes.map((scope: Object) => `${scope}`); }
      break;
    }
    if (!issuers.length) { issuers = [oauthHTTPS(this.resource).origin]; }
    let metadata: McpOAuthConfig | null = null;
    for (const issuer of issuers) {
      for (const candidate of oauthMetadataCandidates(issuer, false)) {
        const response = await this.network.json(candidate, http.RequestMethod.GET, '', 'application/json', () => this.current()); this.check();
        if (response.code === 404) { continue; }
        if (response.code !== 200) { throw new Error('OAuth签发者元数据暂不可用'); }
        metadata = oauthServerMetadata(response.value, issuer); break;
      }
      if (metadata) { break; }
    }
    if (!metadata) { throw new Error('没有找到OAuth元数据，可手动填写Client ID和HTTPS端点'); }
    if (config.issuer && oauthIssuer(config.issuer) !== metadata.issuer) { throw new Error('OAuth签发者与本机配置不一致'); }
    if (config.authorizationEndpoint && oauthHTTPS(config.authorizationEndpoint).toString() !== metadata.authorizationEndpoint) { throw new Error('OAuth授权端点与资源声明不一致'); }
    if (config.tokenEndpoint && oauthHTTPS(config.tokenEndpoint).toString() !== metadata.tokenEndpoint) { throw new Error('OAuth令牌端点与资源声明不一致'); }
    metadata.clientId = config.clientId; metadata.redirectURI = config.redirectURI;
    metadata.scopes = config.scopes || suggestedScopes.join(' ');
    if (!metadata.clientId) {
      if (!metadata.registrationEndpoint) { throw new Error('签发者不支持自动注册，请提供Client ID'); }
      const registration: Record<string, Object> = { 'client_name': 'LeoBot', 'redirect_uris': [metadata.redirectURI],
        'grant_types': ['authorization_code', 'refresh_token'], 'response_types': ['code'], 'token_endpoint_auth_method': 'none' };
      if (metadata.scopes) { registration['scope'] = metadata.scopes; }
      const response = await this.network.json(metadata.registrationEndpoint, http.RequestMethod.POST, JSON.stringify(registration), 'application/json', () => this.current()); this.check();
      if (typeof response.value['client_id'] !== 'string' || (response.value['client_secret'] !== undefined && typeof response.value['client_secret'] !== 'string')) { throw new Error('OAuth注册响应字段类型无效'); }
      const clientId = response.value['client_id'] as string;
      if (response.code < 200 || response.code >= 300 || !clientId || clientId.length > 512 || /[\r\n\u0000]/.test(clientId)) { throw new Error('MCP OAuth客户端注册失败'); }
      metadata.mode = 'dynamic'; metadata.clientId = clientId; this.clientSecret = `${response.value['client_secret'] ?? ''}`;
      if (this.clientSecret.length > 65536 || /[\r\n\u0000]/.test(this.clientSecret)) { throw new Error('OAuth客户端凭据无效'); }
    }
    return metadata;
  }

  accepts(callback: string): boolean {
    if (this.phase !== 'ready' || !this.current()) { return false; }
    return oauthOwnedCallback(callback, this.config.redirectURI, this.state);
  }
  async consume(callback: string): Promise<void> {
    try { await this.complete(callback); }
    catch (error) { this.cancel(); this.onError((error as Error).message); throw error as Error; }
  }
  async complete(callback: string): Promise<void> {
    this.check();
    if (this.phase !== 'ready') { throw new Error('OAuth回调已处理或尚未准备'); }
    const code = oauthCallback(callback, this.config.redirectURI, this.state);
    this.phase = 'exchanging'; // Consume the callback before the first exchange await.
    const form: Record<string, string> = { 'grant_type': 'authorization_code', 'code': code, 'redirect_uri': this.config.redirectURI,
      'client_id': this.config.clientId, 'code_verifier': this.verifier, 'resource': this.resource };
    if (this.clientSecret) { form['client_secret'] = this.clientSecret; }
    try {
      const response = await this.network.json(this.config.tokenEndpoint, http.RequestMethod.POST, oauthForm(form), 'application/x-www-form-urlencoded', () => this.current()); this.check();
      if (response.code !== 200) { throw new Error('OAuth授权码交换失败，请重新登录'); }
      const tokens = oauthTokenReply(response.value, this.clientSecret);
      const record = new McpOAuthRecord(); record.label = this.label; record.resource = this.resource; record.config = this.config;
      record.enabled = true; record.revision = util.generateRandomUUID(true);
      await McpOAuthStore.commit(record, tokens, this.revision, null, () => this.current()); this.check();
      this.phase = 'complete'; this.loopback.close(); this.verifier = ''; this.state = ''; this.clientSecret = '';
      McpOAuth.finished(this); McpOAuth.onAuthorizationChanged(this.label); this.onComplete();
    } catch (error) { this.cancel(); throw error as Error; }
  }
  cancel(): void {
    this.phase = 'cancelled'; this.verifier = ''; this.state = ''; this.clientSecret = ''; this.authorizationURL = ''; this.loopback.close(); this.network.cancel(); McpOAuth.finished(this);
  }
}

export class McpOAuth {
  private static sessions: Map<string, McpOAuthSession> = new Map();
  private static refreshing: Map<string, McpRefreshWork> = new Map();
  static onAuthorizationChanged: (label: string) => void = () => {};
  static attachContext(context: common.Context): void { McpOAuthStore.attachContext(context); }
  static active(session: McpOAuthSession): boolean { return McpOAuth.sessions.get(session.label) === session; }
  static finished(session: McpOAuthSession): void { if (McpOAuth.active(session)) { McpOAuth.sessions.delete(session.label); } }
  static async begin(label: string, resource: string, config: McpOAuthConfig, clientSecret: string,
    isCurrent: () => boolean = () => true): Promise<McpOAuthSession> {
    McpOAuth.sessions.get(label)?.cancel();
    const session = new McpOAuthSession(label, resource, config, clientSecret, isCurrent);
    McpOAuth.sessions.set(label, session); // Reserve before discovery/randomness awaits.
    try { await session.prepare(); return session; } catch (error) { session.cancel(); throw error as Error; }
  }
  static capture(callback: string): boolean {
    let ownedNamespace = false;
    try {
      const parsed = new url.URL(callback);
      const scheme = parsed.protocol.toLowerCase();
      const path = decodeURIComponent(parsed.pathname).toLowerCase();
      ownedNamespace = (['leobot:', 'lobe:', 'leophoneagent:'].includes(scheme) && parsed.hostname === 'mcp' && path.startsWith('/oauth')) ||
        (scheme === 'leophoneagent-mcp:' && parsed.hostname === 'oauth');
    } catch (_err) { return false; }
    for (const session of Array.from(McpOAuth.sessions.values())) {
      if (session.accepts(callback)) { session.consume(callback).catch(() => {}); return true; }
    }
    // Dedicated OAuth callbacks are consumed even when stale or malformed. They never become ordinary prompts/drafts.
    return ownedNamespace;
  }
  static cancel(label: string): void { McpOAuth.sessions.get(label)?.cancel(); }
  static cancelAll(): void { Array.from(McpOAuth.sessions.values()).forEach((session: McpOAuthSession) => { session.cancel(); }); }
  static base64URL(bytes: Uint8Array): string { return new util.Base64Helper().encodeToStringSync(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  static current(authorization: McpOAuthAuthorization): boolean {
    const latest = McpOAuthStore.read(authorization.record.label);
    return latest !== null && latest.enabled && latest.revision === authorization.record.revision &&
      McpOAuthStore.binding(latest) === McpOAuthStore.binding(authorization.record);
  }
  static unchanged(label: string, resource: string, authorization: McpOAuthAuthorization | null): boolean {
    if (authorization) { return McpOAuth.current(authorization); }
    const record = McpOAuthStore.read(label);
    return !record || !record.enabled || record.resource !== oauthResource(resource);
  }

  static async authorization(label: string, resource: string, isCurrent: () => boolean): Promise<McpOAuthAuthorization | null> {
    const record = McpOAuthStore.read(label);
    if (!record || !record.enabled || record.resource !== oauthResource(resource)) { return null; }
    let tokens: McpOAuthTokens;
    try { tokens = await McpOAuthStore.tokens(record); }
    catch (error) {
      const latest = McpOAuthStore.read(label);
      if (isCurrent() && latest && latest.secretRef !== record.secretRef && latest.revision === record.revision && McpOAuthStore.binding(latest) === McpOAuthStore.binding(record)) {
        return await McpOAuth.authorization(label, resource, isCurrent);
      }
      throw error as Error;
    }
    if (!isCurrent()) { throw new Error('MCP OAuth调用已取消'); }
    if (!McpOAuthStore.current(record)) {
      const latest = McpOAuthStore.read(label);
      if (latest && latest.revision === record.revision && latest.secretRef !== record.secretRef && McpOAuthStore.binding(latest) === McpOAuthStore.binding(record)) { return await McpOAuth.authorization(label, resource, isCurrent); }
      throw new Error('MCP OAuth目标或授权身份已改变');
    }
    if (!tokens.accessToken) { throw new Error('MCP需要OAuth授权，请在MCP设置中登录'); }
    if (tokens.expiresAt > 0 && tokens.expiresAt <= Date.now() + 60000) { return await McpOAuth.refreshRecord(record, isCurrent); }
    const result = new McpOAuthAuthorization(); result.header = 'Bearer ' + tokens.accessToken; result.record = record; return result;
  }
  static async refresh(label: string, resource: string, isCurrent: () => boolean): Promise<McpOAuthAuthorization> {
    const record = McpOAuthStore.read(label);
    if (!record || !record.enabled || record.resource !== oauthResource(resource)) { throw new Error('MCP OAuth配置已改变'); }
    return await McpOAuth.refreshRecord(record, isCurrent);
  }
  private static async refreshRecord(record: McpOAuthRecord, isCurrent: () => boolean): Promise<McpOAuthAuthorization> {
    const key = McpOAuthStore.binding(record) + record.secretRef;
    const lease = new McpRefreshLease(); lease.current = isCurrent;
    let work = McpOAuth.refreshing.get(key);
    if (!work) {
      work = new McpRefreshWork(); work.leases.add(lease);
      const pending = work;
      McpOAuth.refreshing.set(key, pending);
      pending.promise = McpOAuth.performRefresh(record, () => Array.from(pending.leases).some((client: McpRefreshLease) => client.current()))
        .finally(() => { McpOAuth.refreshing.delete(key); });
    } else { work.leases.add(lease); }
    try {
      const result = await work.promise;
      if (!isCurrent()) { throw new Error('MCP OAuth调用已取消'); }
      return result;
    } finally { work.leases.delete(lease); }
  }
  private static async performRefresh(record: McpOAuthRecord, isCurrent: () => boolean): Promise<McpOAuthAuthorization> {
    const network = new McpOAuthNetwork();
    try {
      const tokens = await McpOAuthStore.tokens(record);
      const current = (): boolean => McpOAuthStore.current(record);
      if (!isCurrent() || !current()) { throw new Error('MCP OAuth凭据已改变'); }
      if (!tokens.refreshToken) { throw new Error('MCP登录已过期，请重新授权'); }
      const form: Record<string, string> = { 'grant_type': 'refresh_token', 'refresh_token': tokens.refreshToken,
        'client_id': record.config.clientId, 'resource': record.resource };
      if (tokens.clientSecret) { form['client_secret'] = tokens.clientSecret; }
      const response = await network.json(record.config.tokenEndpoint, http.RequestMethod.POST, oauthForm(form), 'application/x-www-form-urlencoded', current);
      if (response.code !== 200 || !current()) { throw new Error('MCP登录刷新失败，请重新授权'); }
      const refreshed = oauthTokenReply(response.value, tokens.clientSecret, tokens.refreshToken);
      const committed = await McpOAuthStore.commit(record, refreshed, record.revision, record.secretRef, current);
      const authorization = new McpOAuthAuthorization(); authorization.header = 'Bearer ' + refreshed.accessToken; authorization.record = committed; return authorization;
    } catch (error) {
      // A competing process may already have committed the rotated generation.
      const winner = McpOAuthStore.read(record.label);
      if (isCurrent() && winner && winner.enabled && winner.revision === record.revision && winner.secretRef !== record.secretRef && McpOAuthStore.binding(winner) === McpOAuthStore.binding(record)) {
        const tokens = await McpOAuthStore.tokens(winner);
        if (tokens.accessToken && (tokens.expiresAt === 0 || tokens.expiresAt > Date.now() + 30000)) {
          const result = new McpOAuthAuthorization(); result.header = 'Bearer ' + tokens.accessToken; result.record = winner; return result;
        }
      }
      throw error as Error;
    } finally { network.cancel(); }
  }
  static exportPublicMetadata(label: string, resource: string): Record<string, Object> | null {
    const record = McpOAuthStore.read(label);
    if (!record || record.resource !== oauthResource(resource)) { return null; }
    const config = record.config;
    const output: Record<string, Object> = {
      'mode': config.mode || 'static', 'clientId': config.clientId, 'issuer': config.issuer,
      'authorizationEndpoint': config.authorizationEndpoint, 'tokenEndpoint': config.tokenEndpoint,
      'registrationEndpoint': config.registrationEndpoint, 'redirectURI': config.redirectURI, 'scopes': config.scopes
    };
    return output;
  }

  static async mergePublicMetadata(context: common.Context, label: string, resource: string, fields: Record<string, Object>): Promise<void> {
    McpOAuth.attachContext(context);
    const config = new McpOAuthConfig();
    config.mode = fields['mode'] === 'dynamic' ? 'dynamic' : 'static';
    config.clientId = `${fields['clientId'] ?? ''}`; config.issuer = `${fields['issuer'] ?? ''}`;
    config.authorizationEndpoint = `${fields['authorizationEndpoint'] ?? ''}`; config.tokenEndpoint = `${fields['tokenEndpoint'] ?? ''}`;
    config.registrationEndpoint = `${fields['registrationEndpoint'] ?? ''}`; config.redirectURI = `${fields['redirectURI'] || config.redirectURI}`;
    config.scopes = `${fields['scopes'] ?? ''}`;
    if (config.clientId.length > 512 || config.scopes.length > 16384) { throw new Error('同步的MCP OAuth配置过长'); }
    if (config.issuer) { config.issuer = oauthIssuer(config.issuer); }
    if (config.authorizationEndpoint) { config.authorizationEndpoint = oauthHTTPS(config.authorizationEndpoint).toString(); }
    if (config.tokenEndpoint) { config.tokenEndpoint = oauthHTTPS(config.tokenEndpoint).toString(); }
    if (config.registrationEndpoint) { config.registrationEndpoint = oauthHTTPS(config.registrationEndpoint).toString(); }
    oauthRedirect(config.redirectURI);
    const proposed = new McpOAuthRecord(); proposed.label = label; proposed.resource = oauthResource(resource); proposed.config = config;
    const old = McpOAuthStore.read(label);
    if (old && old.resource === proposed.resource && old.config.clientId === config.clientId &&
      old.config.authorizationEndpoint === config.authorizationEndpoint && old.config.tokenEndpoint === config.tokenEndpoint) {
      if (!fields['issuer']) { config.issuer = old.config.issuer; }
      if (fields['registrationEndpoint'] === undefined) { config.registrationEndpoint = old.config.registrationEndpoint; }
      if (fields['redirectURI'] === undefined || fields['redirectURI'] === null) { config.redirectURI = old.config.redirectURI; }
      if (fields['scopes'] === undefined || fields['scopes'] === null) { config.scopes = old.config.scopes; }
    }
    if (old && McpOAuthStore.binding(old) === McpOAuthStore.binding(proposed)) { return; }
    McpOAuth.cancel(label); proposed.enabled = false; proposed.revision = util.generateRandomUUID(true);
    await McpOAuthStore.commit(proposed, new McpOAuthTokens(), old?.revision ?? '', old?.secretRef ?? '', () => true);
    McpOAuth.onAuthorizationChanged(label);
  }

  static async signOut(label: string, manual: boolean = false): Promise<void> {
    McpOAuth.cancel(label);
    const old = McpOAuthStore.read(label); if (!old) { return; }
    const previous = await McpOAuthStore.tokens(old); const cleared = new McpOAuthTokens(); cleared.clientSecret = previous.clientSecret;
    const record = JSON.parse(JSON.stringify(old)) as McpOAuthRecord; record.enabled = !manual; record.revision = util.generateRandomUUID(true);
    await McpOAuthStore.commit(record, cleared, old.revision, old.secretRef, () => true);
    McpOAuth.onAuthorizationChanged(label);
  }
  static async purge(label: string): Promise<void> { McpOAuth.cancel(label); await McpOAuthStore.purge(label); McpOAuth.onAuthorizationChanged(label); }
}
