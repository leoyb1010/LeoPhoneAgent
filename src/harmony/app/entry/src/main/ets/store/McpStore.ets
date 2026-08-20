import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { requireProviderRoot } from '../local/LocalProtocol';
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

export class McpStore {
  rows: McpServer[] = [];
  jsonLoadFailed: boolean = false;
  private loaded: boolean = false;

  async load(context: common.UIAbilityContext): Promise<void> {
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

  async save(context: common.UIAbilityContext): Promise<void> {
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

  async upsert(context: common.UIAbilityContext, label: string, url: string, secret: string): Promise<void> {
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

  async remove(context: common.UIAbilityContext, label: string): Promise<void> {
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
    if (this.rows.length === 0) {
      return '';
    }
    const lines: string[] = ['HTTP MCP 服务器（没有 Linux MCP 进程）'];
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      lines.push(`${row.label} ${row.tools.length > 0 ? row.tools : '未拉到 tools/list'}`);
    }
    return lines.join('\n');
  }

  static async call(row: McpServer, name: string, argsText: string): Promise<string> {
    const raw = argsText.trim().length > 0 ? argsText : '{}';
    JSON.parse(raw);
    return McpStore.rpc(row, 'tools/call', `{"name":${JSON.stringify(name)},"arguments":${raw}}`);
  }

  static async listTools(row: McpServer): Promise<string> {
    try {
      const raw = await McpStore.rpc(row, 'tools/list', '{}');
      const obj = JSON.parse(raw) as Record<string, Object>;
      const result = obj['result'] as Record<string, Object> | undefined;
      const tools = result ? result['tools'] : undefined;
      if (!Array.isArray(tools)) {
        return '';
      }
      const names: string[] = [];
      for (let i = 0; i < tools.length; i++) {
        const item = tools[i] as Record<string, Object>;
        const name = `${item['name'] ?? ''}`;
        if (name.length > 0) {
          names.push(name);
        }
      }
      return names.join(', ');
    } catch (_err) {
      return '';
    }
  }

  private static async rpc(row: McpServer, method: string, params: string): Promise<string> {
    const req = http.createHttp();
    const header: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    const secret = await McpStore.secretFor(row);
    if (secret.length > 0) {
      header['Authorization'] = `Bearer ${secret}`;
    }
    try {
      const resp = await req.request(row.url, {
        method: http.RequestMethod.POST,
        header: header,
        extraData: `{"jsonrpc":"2.0","id":1,"method":${JSON.stringify(method)},"params":${params}}`,
        connectTimeout: 20000,
        readTimeout: 20000
      });
      if (resp.responseCode < 200 || resp.responseCode >= 300) {
        throw new Error(`http ${resp.responseCode}`);
      }
      return `${resp.result}`;
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
