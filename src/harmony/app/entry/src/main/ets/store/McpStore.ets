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
  label: string = '';
  url: string = '';
  secret: string = '';
  tools: string = '';
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
  rows: McpServer[] = [];
  jsonLoadFailed: boolean = false;
  private loaded: boolean = false;
  /** 握过手的服务器 → Mcp-Session-Id(服务器不发会话号时是空字符串)。 */
  private static sessions: Map<string, string> = new Map();
  private static nextId: number = 1;

  async load(context: common.Context): Promise<void> {
    if (this.loaded) {
      return;
    }
    const path = context.filesDir + '/mcp.json';
    let migrated = false;
    if (fileIo.accessSync(path)) {
      try {
        const obj = JSON.parse(fileIo.readTextSync(path)) as Record<string, Object>;
        this.rows = McpStore.parse(obj['rows']);
        for (let i = 0; i < this.rows.length; i++) {
          const row = this.rows[i];
          if (row.secret.length > 0) {
            await SecretStore.write(McpStore.alias(row.label), row.secret);
            migrated = true;
          } else {
            row.secret = await SecretStore.read(McpStore.alias(row.label));
          }
        }
      } catch (_err) {
        this.jsonLoadFailed = true;
        this.rows = [];
      }
    }
    this.loaded = true;
    if (migrated && !this.jsonLoadFailed) {
      await this.save(context);
    }
  }

  async save(context: common.Context): Promise<void> {
    if (this.jsonLoadFailed) {
      throw new Error('MCP 档案读坏了，先别保存');
    }
    const held: string[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      held.push(this.rows[i].secret);
      this.rows[i].secret = '';
    }
    try {
      const body = new McpFile();
      body.rows = this.rows;
      const path = context.filesDir + '/mcp.json';
      const file = fileIo.openSync(path,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(file.fd, JSON.stringify(body));
      } finally {
        fileIo.closeSync(file);
      }
    } finally {
      for (let i = 0; i < this.rows.length; i++) {
        this.rows[i].secret = held[i];
      }
    }
  }

  find(label: string): McpServer | null {
    const needle = label.trim().toLowerCase();
    for (let i = 0; i < this.rows.length; i++) {
      if (this.rows[i].label.toLowerCase() === needle) {
        return this.rows[i];
      }
    }
    return this.rows.length === 1 ? this.rows[0] : null;
  }

  async upsert(context: common.Context, label: string, url: string, secret: string): Promise<void> {
    const name = label.trim();
    const root = url.trim();
    if (!name) {
      throw new Error('名称和地址不能空');
    }
    const safeRoot = requireProviderRoot(root);
    let row: McpServer | null = null;
    for (let i = 0; i < this.rows.length; i++) {
      if (this.rows[i].label === name) {
        row = this.rows[i];
      }
    }
    if (!row) {
      row = new McpServer();
      row.label = name;
      this.rows = this.rows.concat([row]);
    }
    row.url = safeRoot;
    row.secret = secret.trim();
    if (row.secret.length > 0) {
      await SecretStore.write(McpStore.alias(name), row.secret);
    }
    row.tools = await McpStore.listTools(row);
    await this.save(context);
  }

  async remove(context: common.Context, label: string): Promise<void> {
    const next: McpServer[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      if (this.rows[i].label !== label) {
        next.push(this.rows[i]);
      }
    }
    this.rows = next;
    await this.save(context);
  }

  promptBlock(): string {
    return mcpPromptBlock(this.rows.map((row: McpServer) => row.label), this.rows.map((row: McpServer) => row.tools));
  }

  /** mcp_tools:这台服务器的工具和参数格式,原样给模型(iOS 的 CLI tools 也是原样)。 */
  static async tools(row: McpServer): Promise<string> {
    const reply = await McpStore.request(row, 'tools/list', '{}', 60000);
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
  static async call(row: McpServer, name: string, argsText: string): Promise<string> {
    const raw = argsText.trim().length > 0 ? argsText : '{}';
    JSON.parse(raw);
    const reply = await McpStore.request(row, 'tools/call', `{"name":${JSON.stringify(name)},"arguments":${raw}}`,
      300000);
    const err = mcpError(reply);
    if (err.length > 0) {
      return `MCP 调用失败:${err}`;
    }
    const result = (JSON.parse(reply) as Record<string, Object>)['result'];
    return `{"server":${JSON.stringify(row.label)},"tool":${JSON.stringify(name)},"result":${JSON.stringify(result ?? null)}}`;
  }

  static async listTools(row: McpServer): Promise<string> {
    try {
      return mcpToolNames(await McpStore.request(row, 'tools/list', '{}', 60000)).join(', ');
    } catch (_err) {
      return '';
    }
  }

  /**
   * 一次 JSON-RPC 请求。第一次先握手(initialize + notifications/initialized,和 iOS 同一个协议版本),
   * 记下 Mcp-Session-Id 之后每次带上;会话过期(带着会话号收到 404)就重新握手一次。
   * 原来不握手、不带 Accept: text/event-stream,按规范实现的服务器大多直接拒。
   */
  private static async request(row: McpServer, method: string, params: string, timeout: number): Promise<string> {
    await McpStore.handshake(row, false);
    McpStore.nextId += 1;
    const id = McpStore.nextId;
    let resp = await McpStore.post(row, mcpRequest(id, method, params), timeout);
    if (resp.code === 404 && (McpStore.sessions.get(row.label) ?? '').length > 0) {
      await McpStore.handshake(row, true);
      resp = await McpStore.post(row, mcpRequest(id, method, params), timeout);
    }
    McpStore.check(resp);
    const reply = mcpReply(resp.body, id);
    if (reply.length === 0) {
      throw new Error('MCP 回复读不懂');
    }
    return reply;
  }

  private static async handshake(row: McpServer, force: boolean): Promise<void> {
    if (!force && McpStore.sessions.has(row.label)) {
      return;
    }
    McpStore.sessions.delete(row.label);
    const init = await McpStore.post(row, mcpRequest(1, 'initialize', mcpInitializeParams(ReleaseCatalog.currentVersion)),
      60000);
    McpStore.check(init);
    const err = mcpError(mcpReply(init.body, 1));
    if (err.length > 0) {
      throw new Error(`MCP 握手失败:${err}`);
    }
    McpStore.sessions.set(row.label, init.session);
    try {
      await McpStore.post(row, mcpNotification('notifications/initialized'), 30000);
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

  private static async post(row: McpServer, body: string, timeout: number): Promise<McpPost> {
    const header: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION
    };
    const session = McpStore.sessions.get(row.label) ?? '';
    if (session.length > 0) {
      header['Mcp-Session-Id'] = session;
    }
    // 地址和钥匙里可以写 $$变量名(iOS 的智谱搜索预设就是 Bearer $$ZHIPU_API_KEY),执行时才换成真值。
    const secret = envStore.expand(await McpStore.secretFor(row)).trim();
    if (secret.length > 0) {
      header['Authorization'] = secret.toLowerCase().startsWith('bearer ') ? secret : `Bearer ${secret}`;
    }
    const req = http.createHttp();
    try {
      const resp = await req.request(envStore.expand(row.url), {
        method: http.RequestMethod.POST,
        header: header,
        extraData: body,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 20000,
        readTimeout: timeout
      });
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
      req.destroy();
    }
  }

  private static alias(label: string): string {
    return `leo.harmony.mcp.${label}`;
  }

  private static async secretFor(row: McpServer): Promise<string> {
    if (row.secret.length > 0) {
      return row.secret;
    }
    return SecretStore.read(McpStore.alias(row.label));
  }

  private static parse(raw: Object | undefined): McpServer[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const out: McpServer[] = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i] as Record<string, Object>;
      const row = new McpServer();
      row.label = `${item['label'] ?? ''}`.trim();
      row.url = `${item['url'] ?? ''}`.trim();
      row.secret = `${item['secret'] ?? ''}`;
      row.tools = `${item['tools'] ?? ''}`;
      if (row.label.length > 0 && row.url.length > 0) {
        out.push(row);
      }
    }
    return out;
  }
}

export const mcpStore: McpStore = new McpStore();
