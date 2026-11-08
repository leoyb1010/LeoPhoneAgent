import { AppNavigation } from '../navigation/AppNavigation';
import { common } from '@kit.AbilityKit';

import { McpOAuthLaunch } from './McpOAuthPage';
import { McpServer, McpStore, mcpStore } from '../store/McpStore';
import { McpStdio } from '../local/McpStdio';
import { ActionButton } from '../theme/Controls';
import { NavBar } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

@Component
export struct McpPage {
  @StorageProp('themeTick') tick: number = 0;
  @StorageProp('mcpStdioTick') stdioTick: number = 0;
  @State nameDraft: string = '';
  @State urlDraft: string = '';
  @State secretDraft: string = '';
  @State headersDraft: string = '{}';
  @State commandDraft: string = '';
  @State argsDraft: string = '[]';
  @State envDraft: string = '{}';
  @State stdio: boolean = false;
  @State rows: McpServer[] = [];
  @State message: string = '';
  @State busy: boolean = false;
  @State saving: boolean = false;
  @State clearBearer: boolean = false;
  @State replaceEmptyValues: boolean = false;
  private editing: McpServer | null = null;
  private environmentEdited: boolean = false;
  private headersEdited: boolean = false;
  private generation: number = 0;
  private active: boolean = false;

  aboutToAppear(): void { this.active = true; this.refresh(); }
  aboutToDisappear(): void { this.active = false; this.generation++; }
  private async refresh(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try { await mcpStore.reload(ctx); this.rows = mcpStore.rows.slice(); }
    catch (err) { this.rows = mcpStore.rows.slice(); this.message = `${err}`; }
  }
  build() {
    NavDestination() {
    Column() {
      NavBar({ title: 'MCP 工具服务器' })
      Scroll() {
        Column({ space: 14 }) {
          Text('连接工具，保留会话').fontSize(24).fontWeight(FontWeight.Bold).fontColor(Tokens.text)
          Text('HTTP 使用远程服务。stdio 命令在本机 Linux 中执行，服务器进程在多次调用间复用。')
            .fontSize(14).fontColor(Tokens.secondary)
          Row({ space: 12 }) {
            Text('本机 stdio').fontSize(16).fontColor(Tokens.text)
            Toggle({ type: ToggleType.Switch, isOn: this.stdio }).selectedColor(Tokens.accent)
              .onChange((value: boolean) => { this.stdio = value; })
          }
          TextInput({ text: this.nameDraft, placeholder: '服务器名称' }).height(48)
            .onChange((value: string) => { this.nameDraft = value; })
          if (this.stdio) {
            TextInput({ text: this.commandDraft, placeholder: '命令，例如 npx / python3 / /bin/sh' }).height(48)
              .onChange((value: string) => { this.commandDraft = value; })
            TextArea({ text: this.argsDraft, placeholder: '参数 JSON 数组，例如 ["-y","@example/mcp-server"]' }).height(100)
              .onChange((value: string) => { this.argsDraft = value; })
            TextArea({ text: this.envDraft, placeholder: '环境变量 JSON，例如 {"API_KEY":"$$MY_KEY"}' }).height(120)
              .onChange((value: string) => { this.envDraft = value; this.environmentEdited = true; })
            Text('环境变量值加密保存在系统凭据库。命令和参数属于配置，敏感参数请使用 $$变量名。缺少 Node/Python 时按运行时需要安装依赖。')
              .fontSize(13).fontColor(Tokens.muted)
          } else {
            TextInput({ text: this.urlDraft, placeholder: 'https://… Streamable HTTP 地址' }).height(48)
              .onChange((value: string) => { this.urlDraft = value; })
            TextInput({ text: this.secretDraft, placeholder: this.editing ? '留空保留同地址的原钥匙' : '可选 Bearer 钥匙，可用 $$变量名' })
              .height(48).type(InputType.Password).onChange((value: string) => { this.secretDraft = value; })
            TextArea({ text: this.headersDraft, placeholder: '自定义请求头 JSON，例如 {"X-Api-Key":"$$MCP_KEY"}' }).height(110)
              .onChange((value: string) => { this.headersDraft = value; this.headersEdited = true; })
            if (this.editing?.secret) { ActionButton({ label: this.clearBearer ? '原钥匙将在保存时清除' : '清除原钥匙', variant: 'quiet', onTap: () => { this.clearBearer = true; this.secretDraft = ''; } }) }
            Text('请求头的值与钥匙一起加密并绑定目标。已有字段留空保留原值，移除JSON键可删除。OAuth登录在已保存服务器的授权入口完成。')
              .fontSize(13).fontColor(Tokens.muted)
          }
          if (this.editing) {
            Row({ space: 12 }) {
              Text('将空字段覆盖为空值').fontSize(13).fontColor(Tokens.secondary).layoutWeight(1)
              Toggle({ type: ToggleType.Switch, isOn: this.replaceEmptyValues }).selectedColor(Tokens.accent)
                .onChange((value: boolean) => { this.replaceEmptyValues = value; })
            }.width('100%')
          }
          ActionButton({ label: '保存并读取工具', busy: this.saving, isEnabled: !this.busy, onTap: () => { this.save(); } })
          if (!this.stdio) {
            ActionButton({ label: '使用智谱搜索预设', variant: 'quiet', isEnabled: !this.busy, onTap: () => {
              this.editing = null; this.nameDraft = 'zhipu-web-search'; this.urlDraft = 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp';
              this.secretDraft = '$$ZHIPU_API_KEY'; this.message = '在环境变量中配置 ZHIPU_API_KEY 后保存';
            } })
          }
          Divider()
          ForEach(this.rows, (row: McpServer) => {
            Column({ space: 10 }) {
              Row({ space: 12 }) {
                Text(row.label).fontSize(18).fontWeight(FontWeight.Medium).fontColor(Tokens.text).layoutWeight(1)
                Toggle({ type: ToggleType.Switch, isOn: row.enabled }).selectedColor(Tokens.accent).enabled(!this.busy)
                  .accessibilityText('启用 ' + row.label).onChange((value: boolean) => { this.setEnabled(row, value); })
              }.width('100%')
              Text(row.transport === 'stdio' ? 'stdio · ' + row.command + (McpStdio.running(row.label) ? ' · 运行中' : ' · 尚未运行') : row.url)
                .fontSize(13).fontColor(Tokens.muted).maxLines(2)
              Text(row.tools || '尚未读取工具清单').fontSize(13).fontColor(Tokens.secondary).maxLines(4)
              Flex({ wrap: FlexWrap.Wrap }) {
                ActionButton({ label: '编辑', variant: 'secondary', fullWidth: false, isEnabled: !this.busy, onTap: () => { this.edit(row); } })
                ActionButton({ label: '读取工具', variant: 'secondary', fullWidth: false, isEnabled: !this.busy && row.enabled, onTap: () => { this.inspect(row); } })
                if (row.transport === 'http') {
                  ActionButton({ label: 'OAuth授权', variant: 'secondary', fullWidth: false, isEnabled: !this.busy && row.enabled, onTap: () => {
                    McpOAuthLaunch.label = row.label; AppNavigation.pushUrl({ url: 'pages/McpOAuthPage' });
                  } })
                }
                if (row.transport === 'stdio') {
                  ActionButton({ label: '停止进程', variant: 'quiet', fullWidth: false, isEnabled: McpStdio.running(row.label), onTap: () => {
                    McpStdio.closeLabel(row.label); this.message = '服务器进程已停止，下次调用会重新启动';
                  } })
                }
                ActionButton({ label: '移除', variant: 'danger', fullWidth: false, isEnabled: !this.busy, onTap: () => {
                  AlertDialog.show({ title: '移除工具服务器', message: row.label, confirm: { value: '移除', action: () => { this.drop(row.label); } }, cancel: () => {} });
                } })
              }
            }.width('100%').padding(16).alignItems(HorizontalAlign.Start).backgroundColor(Tokens.card).borderRadius(16)
          }, (row: McpServer) => row.label + row.secretRef + row.tools)
          if (this.message) { Text(this.message).fontSize(14).fontColor(Tokens.secondary).copyOption(CopyOptions.InApp) }
        }.width('100%').constraintSize({ maxWidth: 560 }).alignItems(HorizontalAlign.Start).padding({ left: 24, right: 24, top: 24, bottom: 40 })
      }.layoutWeight(1).scrollBar(BarState.Off)
    }.width('100%').height('100%').backgroundColor(Tokens.grouped)

    }
    .hideTitleBar(true)
    .onShown(() => { AppNavigation.changed(); })
  }
  private headerTemplate(headers: Record<string, string>): string {
    const names: Record<string, string> = {}; Object.keys(headers).sort().forEach((name: string) => { names[name] = ''; });
    return JSON.stringify(names, null, 2);
  }
  private async setEnabled(row: McpServer, value: boolean): Promise<void> {
    if (row.enabled === value) { return; }
    this.busy = true;
    try { await mcpStore.setEnabled(getContext(this) as common.UIAbilityContext, row.label, value); this.rows = mcpStore.rows.slice(); }
    catch (_err) { this.message = '服务器开关保存失败，原配置已保留'; this.rows = mcpStore.rows.slice(); }
    finally { this.busy = false; }
  }
  private edit(row: McpServer): void {
    this.editing = row; this.nameDraft = row.label; this.urlDraft = row.url; this.secretDraft = '';
    this.stdio = row.transport === 'stdio'; this.commandDraft = row.command; this.argsDraft = JSON.stringify(row.args);
    this.envDraft = JSON.stringify(row.env, null, 2); this.environmentEdited = false;
    this.headersDraft = this.headerTemplate(row.headers); this.headersEdited = false; this.clearBearer = false; this.replaceEmptyValues = false;
  }
  private async save(): Promise<void> {
    this.busy = true; this.saving = true; const generation = ++this.generation;
    const current = (): boolean => this.active && generation === this.generation;
    try {
      const context = getContext(this) as common.UIAbilityContext;
      if (this.stdio) {
        const rawArgs = JSON.parse(this.argsDraft) as Object;
        if (!Array.isArray(rawArgs) || (rawArgs as Object[]).some((arg: Object) => typeof arg !== 'string')) { throw new Error('参数需要是字符串 JSON 数组'); }
        const args = rawArgs as string[];
        const rawEnv = JSON.parse(this.envDraft) as Record<string, Object>;
        if (!rawEnv || Array.isArray(rawEnv) || typeof rawEnv !== 'object') { throw new Error('环境变量需要是 JSON 对象'); }
        let environment: Record<string, string> = {};
        Object.keys(rawEnv).forEach((name: string) => { if (typeof rawEnv[name] !== 'string') { throw new Error('环境变量值需要是字符串'); } environment[name] = `${rawEnv[name]}`; });
        if (this.editing?.transport === 'stdio' && !this.replaceEmptyValues && (!this.environmentEdited || this.envDraft === JSON.stringify(this.editing.env, null, 2))) {
          if (this.editing.command !== this.commandDraft.trim() || JSON.stringify(this.editing.args) !== JSON.stringify(args) || this.editing.label !== this.nameDraft.trim()) {
            if (Object.keys(this.editing.env).length > 0) { throw new Error('更改启动目标后请重新填写环境变量'); }
          } else { environment = JSON.parse(this.editing.secret || '{}') as Record<string, string>; }
        }
        if (!this.replaceEmptyValues && this.editing?.transport === 'stdio' && this.editing.label === this.nameDraft.trim() && this.editing.command === this.commandDraft.trim() && JSON.stringify(this.editing.args) === JSON.stringify(args)) {
          const existing = JSON.parse(this.editing.secret || '{}') as Record<string, string>;
          Object.keys(environment).forEach((name: string) => { if (environment[name] === '' && existing[name] !== undefined) { environment[name] = existing[name]; } });
        }
        await mcpStore.upsertStdio(context, this.nameDraft, this.commandDraft, args, environment, current);
      } else {
        const old = this.editing;
        const secret = !this.clearBearer && !this.secretDraft && old?.transport === 'http' && old.url === this.urlDraft.trim() && old.label === this.nameDraft.trim() ? old.secret : this.secretDraft;
        const parsed = JSON.parse(this.headersDraft) as Record<string, string>;
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') { throw new Error('请求头需要是JSON对象'); }
        let headers = McpStore.validateHeaders(parsed);
        if (old?.transport === 'http' && !this.replaceEmptyValues && (!this.headersEdited || this.headersDraft === this.headerTemplate(old.headers))) {
          if (old.url === this.urlDraft.trim() && old.label === this.nameDraft.trim()) { headers = old.headers; }
          else if (Object.keys(old.headers).length > 0) { throw new Error('更改目标后请重新填写请求头'); }
        }
        if (old?.transport === 'http' && old.url === this.urlDraft.trim() && old.label === this.nameDraft.trim()) {
          if (old.needsLocalHeaders && !this.replaceEmptyValues && this.headersDraft === this.headerTemplate(old.headers)) { throw new Error('请在本机填写此服务器的请求头值'); }
          Object.keys(headers).forEach((name: string) => {
            const prior = Object.keys(old.headers).find((key: string) => key.toLowerCase() === name.toLowerCase());
            if (headers[name] === '' && prior && !old.needsLocalHeaders && !this.replaceEmptyValues) { headers[name] = old.headers[prior]; }
          });
        }
        await mcpStore.upsert(context, this.nameDraft, this.urlDraft, secret, headers);
      }
      if (!current()) { return; }
      this.rows = mcpStore.rows.slice(); this.editing = null; this.secretDraft = ''; this.envDraft = '{}'; this.environmentEdited = false; this.headersDraft = '{}'; this.headersEdited = false;
      const saved = mcpStore.find(this.nameDraft);
      this.message = saved?.tools ? '已保存，工具清单已更新' : '配置已保存，工具清单尚未取到，可点「读取工具」查看原因';
    } catch (err) { if (current()) { this.rows = mcpStore.rows.slice(); this.message = `${err}`; } }
    finally { if (current()) { this.busy = false; this.saving = false; } }
  }
  private async inspect(row: McpServer): Promise<void> {
    this.busy = true; const generation = ++this.generation;
    try { const result = await McpStore.tools(row, () => this.active && generation === this.generation); if (this.active && generation === this.generation) { this.message = result; } }
    catch (err) { if (this.active && generation === this.generation) { this.message = `${err}`; } }
    finally { if (this.active && generation === this.generation) { this.busy = false; } }
  }
  private async drop(label: string): Promise<void> {
    try { await mcpStore.remove(getContext(this) as common.UIAbilityContext, label); this.rows = mcpStore.rows.slice(); this.message = '服务器已移除'; }
    catch (err) { this.message = `${err}`; }
  }
}
