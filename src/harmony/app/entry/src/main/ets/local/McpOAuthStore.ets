import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { AtomicTextFile } from '../store/AtomicFile';
import { BoundSecret } from '../store/BoundSecret';
import { McpOAuthConfig, McpOAuthTokens, oauthResource } from './McpOAuthProtocol';

export class McpOAuthRecord {
  label: string = '';
  resource: string = '';
  config: McpOAuthConfig = new McpOAuthConfig();
  enabled: boolean = true;
  revision: string = '';
  secretRef: string = '';
}
/** MCP-only credential namespace. Metadata stores immutable encrypted generation references. */
export class McpOAuthStore {
  private static context: common.Context | null = null;
  private static tail: Promise<void> = Promise.resolve();
  static attachContext(context: common.Context): void { McpOAuthStore.context = context; }
  private static path(): string {
    if (!McpOAuthStore.context) { throw new Error('MCP OAuth缺少应用上下文'); }
    return McpOAuthStore.context.filesDir + '/mcp-oauth.json';
  }
  private static records(file: AtomicTextFile): McpOAuthRecord[] {
    const raw = file.read(McpOAuthStore.path());
    const records = raw ? JSON.parse(raw) as McpOAuthRecord[] : [];
    if (!Array.isArray(records)) { throw new Error('MCP OAuth配置格式损坏'); }
    return records;
  }
  static read(label: string): McpOAuthRecord | null {
    return McpOAuthStore.records(new AtomicTextFile()).find((record: McpOAuthRecord) => record.label === label) ?? null;
  }
  static binding(record: McpOAuthRecord): string {
    const config = record.config;
    return JSON.stringify(['mcp-oauth', record.label, oauthResource(record.resource), config.issuer, config.authorizationEndpoint,
      config.tokenEndpoint, config.registrationEndpoint, config.clientId, config.redirectURI, config.scopes]);
  }
  static async tokens(record: McpOAuthRecord): Promise<McpOAuthTokens> {
    if (!record.secretRef) { return new McpOAuthTokens(); }
    const encoded = await BoundSecret.read(record.secretRef, McpOAuthStore.binding(record));
    if (!encoded) { throw new Error('MCP OAuth凭据与目标不匹配'); }
    return JSON.parse(encoded) as McpOAuthTokens;
  }
  static current(record: McpOAuthRecord): boolean {
    const latest = McpOAuthStore.read(record.label);
    return latest !== null && latest.enabled && latest.revision === record.revision && latest.secretRef === record.secretRef &&
      McpOAuthStore.binding(latest) === McpOAuthStore.binding(record);
  }
  static commit(record: McpOAuthRecord, tokens: McpOAuthTokens, expectedRevision: string, expectedRef: string | null,
    isCurrent: () => boolean): Promise<McpOAuthRecord> {
    let committed: McpOAuthRecord = record;
    const run = McpOAuthStore.tail.catch(() => {}).then(async () => {
      const file = new AtomicTextFile(); const records = McpOAuthStore.records(file);
      const old = records.find((item: McpOAuthRecord) => item.label === record.label);
      if (!isCurrent() || (old?.revision ?? '') !== expectedRevision || (expectedRef !== null && (old?.secretRef ?? '') !== expectedRef)) {
        throw new Error('MCP OAuth配置或凭据代已改变');
      }
      const next = JSON.parse(JSON.stringify(record)) as McpOAuthRecord;
      if (!next.revision) { next.revision = util.generateRandomUUID(true); }
      next.secretRef = await BoundSecret.stage(McpOAuthStore.binding(next), JSON.stringify(tokens));
      if (!isCurrent()) { throw new Error('MCP OAuth授权已取消'); }
      file.write(McpOAuthStore.path(), JSON.stringify(records.filter((item: McpOAuthRecord) => item.label !== next.label).concat([next])));
      committed = next;
      if (old?.secretRef && old.secretRef !== next.secretRef) { await BoundSecret.retire(old.secretRef); }
    });
    McpOAuthStore.tail = run;
    return run.then(() => committed);
  }
  static purge(label: string): Promise<void> {
    const run = McpOAuthStore.tail.catch(() => {}).then(async () => {
      const file = new AtomicTextFile(); const records = McpOAuthStore.records(file);
      const old = records.find((record: McpOAuthRecord) => record.label === label);
      file.write(McpOAuthStore.path(), JSON.stringify(records.filter((record: McpOAuthRecord) => record.label !== label)));
      if (old?.secretRef) { await BoundSecret.retire(old.secretRef); }
    });
    McpOAuthStore.tail = run;
    return run;
  }
}
