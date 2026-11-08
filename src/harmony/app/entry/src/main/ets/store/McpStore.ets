import { McpOAuth, McpOAuthAuthorization } from '../local/McpOAuth';
import { McpStdio, McpStdioSpec } from '../local/McpStdio';
import { BoundSecret } from './BoundSecret';
import { AtomicTextFile } from './AtomicFile';
import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { requireProviderRoot } from '../local/LocalProtocol';
import {
  MCP_PROTOCOL_VERSION,
  mcpError,
  mcpInitializeParams,
  mcpNotification,
  mcpPromptBlock,
  mcpReply,
  mcpRequest,
  mcpToolNames
} from '../local/AgentText';
import { ReleaseCatalog } from '../release/ReleaseCatalog';
import { envStore } from './EnvStore';
import { SecretStore } from './SecretStore';

export class McpServer {
  enabled: boolean = true;
  label: string = '';
  url: string = '';
  secret: string = '';
  secretRef: string = '';
  tools: string = '';
  transport: string = 'http';
  command: string = '';
  args: string[] = [];
  env: Record<string, string> = {};
  headers: Record<string, string> = {};
  credentialFormat: string = 'bearer';
  needsLocalHeaders: boolean = false;
}

class McpHttpCredential {
  bearer: string = '';
  headers: Record<string, string> = {};
}

class McpFile {
  rows: McpServer[] = [];
}

class McpPost {
  code: number = 0;
  body: string = '';
  session: string = '';
}

export class McpStore {
  private readonly configFile: AtomicTextFile = new AtomicTextFile();
  rows: McpServer[] = [];
  jsonLoadFailed: boolean = false;
  private loaded: boolean = false;
  private pendingLoad: Promise<void> | null = null;
  /** 握过手的服务器 → Mcp-Session-Id(服务器不发会话号时是空字符串)。 */
  private static sessions: Map<string, string> = new Map();
  private static nextId: number = 1;
  private static configuredDefinitions: Map<string, string> = new Map();
  private static knownLabels: Set<string> = new Set();
  private static stdioConfigurations: Map<string, string> = new Map();

  private writes: Promise<void> = Promise.resolve();

  private serial(action: () => Promise<void>): Promise<void> {
    const next = this.writes.then(action);
    this.writes = next.catch(() => {});
    return next;
  }

  reload(context: common.Context): Promise<void> {
    McpStdio.attachContext(context);
    McpOAuth.attachContext(context);
    McpOAuth.onAuthorizationChanged = (label: string): void => {
      McpStore.sessions.forEach((_session: string, key: string) => {
        if ((JSON.parse(key) as string[])[0] === label) { McpStore.sessions.delete(key); }
      });
    };
    return this.serial(async () => {
      if (this.pendingLoad) await this.pendingLoad.catch(() => {});
      this.loaded = false; this.rows = []; this.jsonLoadFailed = false;
      await this.readDisk(context, false);
    });
  }

  async load(context: common.Context): Promise<void> {
    McpStdio.attachContext(context);
    McpOAuth.attachContext(context);
    McpOAuth.onAuthorizationChanged = (label: string): void => {
      McpStore.sessions.forEach((_session: string, key: string) => {
        if ((JSON.parse(key) as string[])[0] === label) { McpStore.sessions.delete(key); }
      });
    };
    if (this.pendingLoad) { await this.pendingLoad; return; }
    if (this.loaded) return;
    if (!this.pendingLoad) this.pendingLoad = this.readDisk(context, true).finally(() => { this.pendingLoad = null; });
    await this.pendingLoad;
  }

  private async readDisk(context: common.Context, migrate: boolean): Promise<void> {
    let needsMigration = false;
    try {
      const raw = this.configFile.read(context.filesDir + '/mcp.json');
      this.rows = raw ? McpStore.parse((JSON.parse(raw) as Record<string, Object>)['rows']) : [];
      for (let i = 0; i < this.rows.length; i++) {
        const row = this.rows[i];
        if (!row.secretRef) needsMigration = true;
        const encoded = row.secretRef ? await BoundSecret.read(row.secretRef, McpStore.binding(row)) :
          (row.secret || await SecretStore.read(McpStore.alias(row.label)));
        if (row.transport === 'http' && row.credentialFormat === 'http-v1') {
          const credential = McpStore.decodeHttpCredential(row, encoded); row.secret = credential.bearer; row.headers = credential.headers;
        } else { row.secret = encoded; }
      }
      this.jsonLoadFailed = false;
      this.loaded = true;
      McpStore.recordStdioConfigurations(this.rows);
    } catch (error) {
      this.rows = []; this.jsonLoadFailed = true;
      this.loaded = false;
      throw error as Error;
    }
    if (migrate && needsMigration) await this.persist(context, this.rows);
  }

  save(context: common.Context): Promise<void> {
    return this.serial(async () => { await this.load(context); await this.persist(context, this.rows); });
  }

  private async persist(context: common.Context, rows: McpServer[]): Promise<void> {
    if (this.jsonLoadFailed) throw new Error('MCP 档案读坏了，先别保存');
    const previous = this.rows;
    const next = McpStore.parse(JSON.parse(JSON.stringify(rows)) as Object[]);
    try {
      const body = new McpFile();
      for (let i = 0; i < next.length; i++) {
        const row = next[i];
        if (!row.secretRef) {
          if (row.transport === 'http' && Object.keys(row.headers).length > 0) {
            row.credentialFormat = 'http-v1';
            const credential = new McpHttpCredential(); credential.bearer = row.secret; credential.headers = row.headers;
            row.secretRef = await BoundSecret.stage(McpStore.binding(row), JSON.stringify(credential));
          } else { row.secretRef = await BoundSecret.stage(McpStore.binding(row), row.secret); }
        }
        const bare = new McpServer();
        bare.enabled = row.enabled; bare.label = row.label; bare.url = row.url; bare.tools = row.tools; bare.secretRef = row.secretRef;
        bare.credentialFormat = row.credentialFormat; bare.needsLocalHeaders = row.needsLocalHeaders;
        Object.keys(row.headers).forEach((name: string) => { bare.headers[name] = ''; });
        bare.transport = row.transport; bare.command = row.command; bare.args = row.args.slice();
        Object.keys(row.env).forEach((name: string) => { bare.env[name] = ''; });
        body.rows.push(bare);
      }
      this.configFile.write(context.filesDir + '/mcp.json', JSON.stringify(body));
      this.rows = next;
      McpStore.recordStdioConfigurations(this.rows);
    } catch (error) {
      // 恢复不能等待正在执行本次迁移的 pendingLoad，否则会自等待。
      this.rows = []; this.jsonLoadFailed = false;
      await this.readDisk(context, false);
      throw error as Error;
    }
    for (let i = 0; i < previous.length; i++) {
      const old = previous[i];
      if (old.secretRef && !next.some((row: McpServer) => row.secretRef === old.secretRef)) await BoundSecret.retire(old.secretRef);
      if (!old.secretRef) await SecretStore.remove(McpStore.alias(old.label));
    }
  }

  private static binding(row: McpServer): string {
    if (row.transport === 'stdio') { return JSON.stringify(['mcp-stdio', row.label, row.command, row.args, Object.keys(row.env).sort()]); }
    if (Object.keys(row.headers).length > 0) { return JSON.stringify(['mcp-http', row.label, row.url, row.credentialFormat, Object.keys(row.headers).map((name: string) => name.toLowerCase()).sort()]); }
    return JSON.stringify(['mcp', row.label, row.url]);
  }

  private static recordStdioConfigurations(rows: McpServer[]): void {
    McpStore.configuredDefinitions = new Map();
    rows.forEach((row: McpServer) => { McpStore.knownLabels.add(row.label); McpStore.configuredDefinitions.set(row.label, McpStore.binding(row) + row.secretRef + row.enabled); });
    const next: Map<string, string> = new Map();
    rows.forEach((row: McpServer) => { if (row.transport === 'stdio' && row.enabled) { next.set(row.label, McpStore.binding(row) + row.secretRef); } });
    McpStore.stdioConfigurations.forEach((signature: string, label: string) => {
      if (next.get(label) !== signature) { McpStdio.closeLabel(label); }
    });
    McpStore.stdioConfigurations = next;
  }

  find(label: string): McpServer | null {
    const needle = label.trim().toLowerCase();
    for (let i = 0; i < this.rows.length; i++) {
      if (this.rows[i].enabled && this.rows[i].label.toLowerCase() === needle) {
        return this.rows[i];
      }
    }
    if (needle.length > 0) return null;
    const enabled = this.rows.filter((row: McpServer) => row.enabled);
    return enabled.length === 1 ? enabled[0] : null;
  }

  setEnabled(context: common.Context, label: string, enabled: boolean): Promise<void> {
    return this.serial(async () => {
      await this.load(context);
      const next = McpStore.parse(JSON.parse(JSON.stringify(this.rows)) as Object[]);
      const row = next.find((item: McpServer) => item.label === label);
      if (!row) throw new Error('MCP服务器已变化，请刷新后重试');
      row.enabled = enabled; await this.persist(context, next);
    });
  }

  mergeReplicaMetadata(context: common.Context, label: string, url: string, enabled: boolean = true): Promise<void> {
    return this.serial(async () => {
      await this.load(context);
      const root = requireProviderRoot(url.trim());
      const old = this.rows.find((row: McpServer) => row.label === label);
      const row = new McpServer(); row.enabled = enabled; row.label = label; row.url = root;
      if (old && old.url === root) {
        row.secret = old.secret; row.secretRef = old.secretRef; row.tools = old.tools; row.credentialFormat = old.credentialFormat;
        const names = Object.keys(old.headers); for (let i = 0; i < names.length; i++) row.headers[names[i]] = old.headers[names[i]];
      }
      const next = this.rows.filter((item: McpServer) => item.label !== label).concat([row]);
      await this.persist(context, next);
    });
  }

  mergeHTTPPublicMetadata(context: common.Context, label: string, url: string, headerNames: string[], enabled: boolean = true): Promise<void> {
    return this.serial(async () => {
      await this.load(context);
      const row = new McpServer(); row.label = label; row.url = requireProviderRoot(url); row.enabled = enabled;
      const old = this.rows.find((item: McpServer) => item.label === label && item.transport === 'http');
      const sameDestination = old !== undefined && old.url === row.url;
      headerNames.forEach((name: string) => {
        const previous = sameDestination ? Object.keys(old.headers).find((key: string) => key.toLowerCase() === name.toLowerCase()) : undefined;
        row.headers[name] = previous && old ? old.headers[previous] : '';
        if (!previous) { row.needsLocalHeaders = true; }
      });
      row.headers = McpStore.validateHeaders(row.headers);
      if (sameDestination) {
        row.secret = old.secret; row.tools = old.tools;
        if (JSON.stringify(Object.keys(old.headers).map((name: string) => name.toLowerCase()).sort()) === JSON.stringify(headerNames.map((name: string) => name.toLowerCase()).sort())) {
          row.credentialFormat = old.credentialFormat; row.secretRef = old.secretRef; row.needsLocalHeaders = old.needsLocalHeaders;
        }
      } else if (old) { await McpOAuth.purge(label); }
      await this.persist(context, this.rows.filter((item: McpServer) => item.label !== label).concat([row]));
    });
  }

  upsertStdio(context: common.Context, label: string, command: string, args: string[], environment: Record<string, string>, isCurrent: () => boolean = () => true): Promise<void> {
    return this.serial(async () => {
      await this.load(context);
      const row = new McpServer(); row.transport = 'stdio'; row.label = label.trim(); row.command = command.trim(); row.args = args.slice();
      if (!row.label || !row.command || row.command.includes('\u0000') || row.args.length > 128 || row.args.some((arg: string) => arg.includes('\u0000'))) {
        throw new Error('stdio MCP名称、命令或参数无效');
      }
      if (Object.keys(environment).length > 64) { throw new Error('stdio MCP环境变量过多'); }
      Object.keys(environment).sort().forEach((name: string) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof environment[name] !== 'string' || environment[name].includes('\u0000')) {
          throw new Error('stdio MCP环境变量无效');
        }
        row.env[name] = ''; // Public metadata contains names only.
      });
      row.secret = JSON.stringify(environment);
      if (this.rows.some((item: McpServer) => item.label === row.label && item.transport === 'http')) { await McpOAuth.purge(row.label); }
      await this.persist(context, this.rows.filter((item: McpServer) => item.label !== row.label).concat([row]));
      const committed = this.find(row.label);
      if (committed) {
        const tools = await McpStore.listTools(committed, isCurrent);
        if (!isCurrent()) { return; }
        const next = McpStore.parse(JSON.parse(JSON.stringify(this.rows)) as Object[]);
        const update = next.find((item: McpServer) => item.label === row.label);
        if (update) { update.tools = tools; }
        await this.persist(context, next);
      }
    });
  }

  mergeStdioReplicaMetadata(context: common.Context, label: string, command: string, args: string[], envNames: string[], enabled: boolean = true): Promise<void> {
    return this.serial(async () => {
      await this.load(context);
      const row = new McpServer(); row.transport = 'stdio'; row.label = label; row.command = command; row.args = args.slice(); row.enabled = enabled;
      if (!label || !command || command.includes('\u0000') || args.some((arg: string) => arg.includes('\u0000'))) { throw new Error('同步的stdio MCP配置无效'); }
      envNames.sort().forEach((name: string) => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { throw new Error('同步的MCP环境变量名无效'); } row.env[name] = ''; });
      const old = this.rows.find((item: McpServer) => item.label === label);
      if (old && McpStore.binding(old) === McpStore.binding(row)) { row.secret = old.secret; row.secretRef = old.secretRef; row.tools = old.tools; }
      else { row.secret = '{}'; }
      await this.persist(context, this.rows.filter((item: McpServer) => item.label !== label).concat([row]));
    });
  }

  upsert(context: common.Context, label: string, url: string, secret: string, headers: Record<string, string> = {}): Promise<void> {
    return this.serial(async () => {
      await this.load(context);
      const row = new McpServer();
      row.label = label.trim();
      if (!row.label) throw new Error('名称和地址不能空');
      row.url = requireProviderRoot(url.trim());
      row.secret = secret.trim();
      row.headers = McpStore.validateHeaders(headers);
      if (row.secret && Object.keys(row.headers).some((name: string) => name.toLowerCase() === 'authorization')) { throw new Error('MCP只能选择一个手动Authorization来源'); }
      // 先提交 endpoint+secretRef 同一代，失败时不会向任何服务器发新令牌。
      const proposed = this.rows.slice();
      const oldDestination = this.rows.find((item: McpServer) => item.label === row.label);
      if (oldDestination && (oldDestination.transport !== 'http' || oldDestination.url !== row.url)) { await McpOAuth.purge(row.label); }
      const index = proposed.findIndex((item: McpServer) => item.label === row.label);
      if (index >= 0) proposed[index] = row; else proposed.push(row);
      await this.persist(context, proposed);
      const committed = this.rows.find((item: McpServer) => item.label === row.label);
      if (committed) {
        const tools = await McpStore.listTools(committed);
        const next = McpStore.parse(JSON.parse(JSON.stringify(this.rows)) as Object[]);
        const update = next.find((item: McpServer) => item.label === row.label);
        if (update) update.tools = tools;
        await this.persist(context, next);
      }
    });
  }

  remove(context: common.Context, label: string): Promise<void> {
    return this.serial(async () => {
      await this.load(context);
      await McpOAuth.purge(label);
      await this.persist(context, this.rows.filter((row: McpServer) => row.label !== label));
    });
  }

  promptBlock(): string {
    const enabled = this.rows.filter((row: McpServer) => row.enabled);
    return mcpPromptBlock(enabled.map((row: McpServer) => row.label), enabled.map((row: McpServer) => row.tools));
  }

  /** mcp_tools:这台服务器的工具和参数格式,原样给模型(iOS 的 CLI tools 也是原样)。 */
  static async tools(row: McpServer, isCurrent: () => boolean = () => true): Promise<string> {
    const reply = await McpStore.request(row, 'tools/list', '{}', 60000, isCurrent);
    const err = mcpError(reply);
    if (err.length > 0) {
      return `拉不到工具列表:${err}`;
    }
    const result = (JSON.parse(reply) as Record<string, Object>)['result'] as Record<string, Object> | undefined;
    const tools = result ? result['tools'] : undefined;
    const list: Object[] = Array.isArray(tools) ? tools as Object[] : [];
    return `{"server":${JSON.stringify(row.label)},"tools":${JSON.stringify(list)},"count":${list.length}}`;
  }

  /** mcp_call:结果原样给模型(content 数组和 isError 都在里面)。 */
  static async call(row: McpServer, name: string, argsText: string, isCurrent: () => boolean = () => true): Promise<string> {
    const raw = argsText.trim().length > 0 ? argsText : '{}';
    JSON.parse(raw);
    const reply = await McpStore.request(row, 'tools/call', `{"name":${JSON.stringify(name)},"arguments":${raw}}`,
      300000, isCurrent);
    const err = mcpError(reply);
    if (err.length > 0) {
      return `MCP 调用失败:${err}`;
    }
    const result = (JSON.parse(reply) as Record<string, Object>)['result'];
    return `{"server":${JSON.stringify(row.label)},"tool":${JSON.stringify(name)},"result":${JSON.stringify(result ?? null)}}`;
  }

  static async listTools(row: McpServer, isCurrent: () => boolean = () => true): Promise<string> {
    try {
      return mcpToolNames(await McpStore.request(row, 'tools/list', '{}', 60000, isCurrent)).join(', ');
    } catch (_err) {
      return '';
    }
  }

  /**
   * 一次 JSON-RPC 请求。第一次先握手(initialize + notifications/initialized,和 iOS 同一个协议版本),
   * 记下 Mcp-Session-Id 之后每次带上;会话过期(带着会话号收到 404)就重新握手一次。
   * 原来不握手、不带 Accept: text/event-stream,按规范实现的服务器大多直接拒。
   */
  private static async request(row: McpServer, method: string, params: string, timeout: number, isCurrent: () => boolean = () => true): Promise<string> {
    if (!isCurrent()) throw new Error('MCP调用已取消');
    if (row.transport === 'stdio') { return await McpStore.stdioRequest(row, method, params, timeout, isCurrent); }
    await McpStore.handshake(row, false, isCurrent);
    McpStore.nextId += 1;
    const id = McpStore.nextId;
    let resp = await McpStore.post(row, mcpRequest(id, method, params), timeout, isCurrent);
    if (resp.code === 404 && (McpStore.sessions.get(McpStore.sessionKey(row)) ?? '').length > 0) {
      await McpStore.handshake(row, true, isCurrent);
      resp = await McpStore.post(row, mcpRequest(id, method, params), timeout, isCurrent);
    }
    McpStore.check(resp);
    const reply = mcpReply(resp.body, id);
    if (reply.length === 0) {
      throw new Error('MCP 回复读不懂');
    }
    return reply;
  }

  private static async stdioRequest(row: McpServer, method: string, params: string, timeout: number, isCurrent: () => boolean): Promise<string> {
    const signature = McpStore.binding(row) + row.secretRef;
    const encoded = await McpStore.secretFor(row);
    const environment: Record<string, string> = encoded ? JSON.parse(encoded) as Record<string, string> : {};
    const resolve = (): McpStdioSpec => {
      const spec = new McpStdioSpec(); spec.label = row.label;
      spec.command = JSON.parse(envStore.expand(JSON.stringify(row.command))) as string;
      spec.args = row.args.map((arg: string) => JSON.parse(envStore.expand(JSON.stringify(arg))) as string);
      Object.keys(row.env).sort().forEach((name: string) => {
        if (environment[name] === undefined) { throw new Error('stdio MCP环境变量需要在本机重新配置'); }
        spec.env[name] = JSON.parse(envStore.expand(JSON.stringify(environment[name]))) as string;
      });
      return spec;
    };
    const spec = resolve(); const destination = JSON.stringify(spec);
    const current = (): boolean => isCurrent() && McpStore.stdioConfigurations.get(row.label) === signature && JSON.stringify(resolve()) === destination;
    if (!current()) { throw new Error('MCP调用已取消或stdio配置已改变'); }
    return await McpStdio.request(spec, method, params, timeout, current);
  }

  private static async handshake(row: McpServer, force: boolean, isCurrent: () => boolean = () => true): Promise<void> {
    if (!force && McpStore.sessions.has(McpStore.sessionKey(row))) {
      return;
    }
    McpStore.sessions.delete(McpStore.sessionKey(row));
    const init = await McpStore.post(row, mcpRequest(1, 'initialize', mcpInitializeParams(ReleaseCatalog.currentVersion)),
      60000, isCurrent);
    McpStore.check(init);
    const err = mcpError(mcpReply(init.body, 1));
    if (err.length > 0) {
      throw new Error(`MCP 握手失败:${err}`);
    }
    McpStore.sessions.set(McpStore.sessionKey(row), init.session);
    try {
      await McpStore.post(row, mcpNotification('notifications/initialized'), 30000, isCurrent);
    } catch (_err) {
      // 通知回不回都行
    }
  }

  private static check(resp: McpPost): void {
    if (resp.code === 401 || resp.code === 403) {
      throw new Error(`MCP 服务器不认钥匙(http ${resp.code});钥匙可以写成 $$变量名,在「环境变量」里填`);
    }
    if (resp.code < 200 || resp.code >= 300) {
      throw new Error(`MCP 服务器回了 http ${resp.code}`);
    }
  }

  private static async post(row: McpServer, body: string, timeout: number, isCurrent: () => boolean = () => true): Promise<McpPost> {
    const current = (): boolean => isCurrent() && (!McpStore.knownLabels.has(row.label) || McpStore.configuredDefinitions.get(row.label) === McpStore.binding(row) + row.secretRef + row.enabled);
    if (!current()) { throw new Error('MCP调用已取消或服务器配置已改变'); }
    if (row.needsLocalHeaders) { throw new Error('此MCP的请求头需要在本机配置后使用'); }
    const header: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION
    };
    const session = McpStore.sessions.get(McpStore.sessionKey(row)) ?? '';
    if (session.length > 0) {
      header['Mcp-Session-Id'] = session;
    }
    // 地址和钥匙里可以写 $$变量名(iOS 的智谱搜索预设就是 Bearer $$ZHIPU_API_KEY),执行时才换成真值。
    const destination = envStore.expand(row.url);
    const secretReference = row.secretRef;
    const credential = row.credentialFormat === 'http-v1' ? McpStore.decodeHttpCredential(row, await McpStore.encodedSecretFor(row)) : new McpHttpCredential();
    if (row.credentialFormat !== 'http-v1') { credential.bearer = await McpStore.secretFor(row); }
    const secret = (JSON.parse(envStore.expand(JSON.stringify(credential.bearer))) as string).trim();
    const expandedHeaders: Record<string, string> = {};
    Object.keys(credential.headers).forEach((name: string) => { expandedHeaders[name] = JSON.parse(envStore.expand(JSON.stringify(credential.headers[name]))) as string; });
    const customHeaders = McpStore.validateHeaders(expandedHeaders);
    if (Object.keys(customHeaders).some((name: string) => name.toLowerCase() === 'authorization') && secret.trim()) { throw new Error('MCP只能选择一个Authorization来源'); }
    const authorizationName = Object.keys(customHeaders).find((name: string) => name.toLowerCase() === 'authorization');
    Object.keys(customHeaders).forEach((name: string) => { if (name.toLowerCase() !== 'authorization') { header[name] = customHeaders[name]; } });
    if (/[\r\n\u0000]/.test(secret)) { throw new Error('MCP钥匙含非法换行'); }
    if (!current() || destination !== envStore.expand(row.url) || secretReference !== row.secretRef) {
      throw new Error('MCP调用已取消或配置已改变');
    }
    let authorization = await McpOAuth.authorization(row.label, destination, current);
    if (!current() || destination !== envStore.expand(row.url) || secretReference !== row.secretRef || !McpOAuth.unchanged(row.label, destination, authorization)) { throw new Error('MCP授权或目标已改变'); }
    if (authorization) { header['Authorization'] = authorization.header; }
    else if (secret.length > 0) { header['Authorization'] = secret.toLowerCase().startsWith('bearer ') ? secret : `Bearer ${secret}`; }
    else if (authorizationName) { header['Authorization'] = customHeaders[authorizationName]; }
    const req = http.createHttp();
    const cancellation = setInterval(() => { try { if (!current()) { req.destroy(); } } catch (_err) { req.destroy(); } }, 50);
    try {
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.POST,
        header: header,
        extraData: body,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 20000, maxRedirects: 0, usingCache: false,
        readTimeout: timeout
      };
      let resp = await req.request(destination, options);
      if (!McpOAuth.unchanged(row.label, destination, authorization)) { throw new Error('MCP授权来源已改变'); }
      if (resp.responseCode === 401 && authorization && current()) {
        const latest = await McpOAuth.authorization(row.label, destination, current);
        authorization = latest && latest.record.secretRef !== authorization.record.secretRef ? latest : await McpOAuth.refresh(row.label, destination, current);
        if (!current() || !McpOAuth.current(authorization) || destination !== envStore.expand(row.url) || secretReference !== row.secretRef) { throw new Error('MCP刷新后目标或凭据已改变'); }
        header['Authorization'] = authorization.header;
        resp = await req.request(destination, options);
      }
      if (!current() || !McpOAuth.unchanged(row.label, destination, authorization)) { throw new Error('MCP调用已取消或授权已改变'); }
      const out = new McpPost();
      out.code = resp.responseCode;
      out.body = `${resp.result ?? ''}`;
      out.session = session;
      if (resp.header) {
        const headers = resp.header as Record<string, Object>;
        Object.keys(headers).forEach((key: string) => {
          if (key.toLowerCase() === 'mcp-session-id') {
            out.session = `${headers[key]}`;
          }
        });
      }
      return out;
    } finally {
      clearInterval(cancellation);
      req.destroy();
    }
  }

  private static sessionKey(row: McpServer): string { return JSON.stringify([row.label, row.url, row.secretRef]); }

  private static alias(label: string): string {
    return `leo.harmony.mcp.${label}`;
  }

  static validateHeaders(headers: Record<string, string>): Record<string, string> {
    const output: Record<string, string> = {};
    const seen: Set<string> = new Set();
    const reserved = ['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version'];
    if (Object.keys(headers).length > 64) { throw new Error('MCP自定义请求头过多'); }
    Object.keys(headers).forEach((name: string) => {
      const lower = name.toLowerCase();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || reserved.includes(lower) || seen.has(lower) || typeof headers[name] !== 'string' || headers[name].length > 16384 || /[\u0000-\u0008\u000A-\u001F\u007F]/.test(headers[name])) {
        throw new Error('MCP请求头名称、值或保留字段无效');
      }
      seen.add(lower); output[name] = headers[name];
    });
    return output;
  }

  private static decodeHttpCredential(row: McpServer, encoded: string): McpHttpCredential {
    if (!encoded) { throw new Error('MCP请求头凭据与目标不匹配，请重新配置'); }
    const value = JSON.parse(encoded) as McpHttpCredential;
    if (typeof value.bearer !== 'string' || !value.headers) { throw new Error('MCP请求头凭据格式无效'); }
    value.headers = McpStore.validateHeaders(value.headers);
    const expected = Object.keys(row.headers).map((name: string) => name.toLowerCase()).sort();
    const actual = Object.keys(value.headers).map((name: string) => name.toLowerCase()).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) { throw new Error('MCP请求头凭据目标已改变'); }
    return value;
  }

  private static async encodedSecretFor(row: McpServer): Promise<string> {
    return row.secretRef ? BoundSecret.read(row.secretRef, McpStore.binding(row)) : row.secret;
  }
  private static async secretFor(row: McpServer): Promise<string> {
    const encoded = await McpStore.encodedSecretFor(row);
    return row.transport === 'http' && row.credentialFormat === 'http-v1' ? McpStore.decodeHttpCredential(row, encoded).bearer : encoded;
  }

  private static parse(raw: Object | undefined): McpServer[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const out: McpServer[] = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i] as Record<string, Object>;
      const row = new McpServer();
      row.enabled = item['enabled'] !== false;
      row.label = `${item['label'] ?? ''}`.trim();
      row.url = `${item['url'] ?? ''}`.trim();
      row.secret = `${item['secret'] ?? ''}`;
      row.secretRef = `${item['secretRef'] ?? ''}`;
      row.tools = `${item['tools'] ?? ''}`;
      row.needsLocalHeaders = item['needsLocalHeaders'] === true;
      row.credentialFormat = item['credentialFormat'] === 'http-v1' ? 'http-v1' : 'bearer';
      const headers = item['headers'] as Record<string, string> | undefined;
      row.headers = headers && !Array.isArray(headers) && typeof headers === 'object' ? McpStore.validateHeaders(headers) : {};
      row.command = `${item['command'] ?? ''}`.trim();
      row.transport = item['transport'] === 'stdio' || row.command.length > 0 ? 'stdio' : 'http';
      const argumentsValue = item['args']; row.args = Array.isArray(argumentsValue) ? argumentsValue.map((arg: Object) => `${arg}`) : [];
      const environment = item['env'] as Record<string, Object> | undefined;
      if (environment && !Array.isArray(environment) && typeof environment === 'object') {
        Object.keys(environment).forEach((name: string) => { row.env[name] = `${environment[name]}`; });
      }
      if (row.transport === 'stdio' && !row.secretRef && !row.secret) { row.secret = JSON.stringify(row.env); }
      if (row.label.length > 0 && (row.transport === 'stdio' ? row.command.length > 0 : row.url.length > 0)) {
        out.push(row);
      }
    }
    return out;
  }
}

export const mcpStore: McpStore = new McpStore();
