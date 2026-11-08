import { AppNavigation } from '../navigation/AppNavigation';
import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { url } from '@kit.ArkTS';
import { mcpStore } from '../store/McpStore';
import { envStore } from '../store/EnvStore';
import { McpOAuth, McpOAuthSession } from '../local/McpOAuth';
import { McpOAuthConfig, oauthRedirect, oauthResource } from '../local/McpOAuthProtocol';
import { McpOAuthStore } from '../local/McpOAuthStore';
import { ActionButton } from '../theme/Controls';
import { NavBar } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

export class McpOAuthLaunch { static label: string = ''; }
@Component
export struct McpOAuthPage {
  @StorageProp('themeTick') themeTick: number = 0;
  @State clientId: string = '';
  @State issuer: string = '';
  @State authorizationEndpoint: string = '';
  @State tokenEndpoint: string = '';
  @State redirectURI: string = 'leobot://mcp/oauth/callback';
  @State scopes: string = '';
  @State clientSecret: string = '';
  @State authorizationURL: string = '';
  @State message: string = '';
  @State busy: boolean = false;
  @State issuerName: string = '';
  private label: string = '';
  private generation: number = 0;
  private active: boolean = false;
  private session: McpOAuthSession | null = null;
  private controller: webview.WebviewController = new webview.WebviewController();

  aboutToAppear(): void { this.active = true; this.label = McpOAuthLaunch.label; this.load(); }
  aboutToDisappear(): void { this.active = false; this.cancel(); this.clientSecret = ''; }
  private async load(): Promise<void> {
    try {
      const context = getContext(this) as common.UIAbilityContext;
      await mcpStore.load(context); await envStore.load(context);
      const record = McpOAuthStore.read(this.label);
      if (record) {
        const config = record.config; this.clientId = config.clientId; this.issuer = config.issuer; this.authorizationEndpoint = config.authorizationEndpoint;
        this.tokenEndpoint = config.tokenEndpoint; this.redirectURI = config.redirectURI; this.scopes = config.scopes;
        this.message = record.enabled ? 'OAuth已配置，登录状态由本机加密凭据决定' : '客户端已配置，尚未完成授权';
      }
    } catch (_err) { this.message = 'OAuth配置暂不可读取，请返回MCP设置重试'; }
  }
  build() {
    NavDestination() {
    Column() {
      NavBar({ title: 'MCP 授权' })
      if (!this.authorizationURL) {
        Scroll() {
          Column({ space: 14 }) {
            Text(this.label).fontSize(24).fontWeight(FontWeight.Bold).fontColor(Tokens.text)
            Text('自动从MCP资源发现签发者并注册公共客户端。也可填写已有Client ID与端点。授权仅绑定这一个MCP资源。')
              .fontSize(14).fontColor(Tokens.secondary)
            TextInput({ text: this.clientId, placeholder: 'Client ID，留空自动注册' }).height(48).onChange((value: string) => { this.clientId = value.trim(); })
            TextInput({ text: this.issuer, placeholder: 'Issuer，可选' }).height(48).onChange((value: string) => { this.issuer = value.trim(); })
            TextInput({ text: this.authorizationEndpoint, placeholder: 'Authorization Endpoint，留空自动发现' }).height(48)
              .onChange((value: string) => { this.authorizationEndpoint = value.trim(); })
            TextInput({ text: this.tokenEndpoint, placeholder: 'Token Endpoint，留空自动发现' }).height(48).onChange((value: string) => { this.tokenEndpoint = value.trim(); })
            TextInput({ text: this.redirectURI, placeholder: '本应用回调或 http://127.0.0.1:3100/oauth/callback' }).height(48)
              .onChange((value: string) => { this.redirectURI = value.trim(); })
            TextInput({ text: this.scopes, placeholder: 'Scopes，空格分隔' }).height(48).onChange((value: string) => { this.scopes = value; })
            TextInput({ text: this.clientSecret, placeholder: '可选 Client Secret，仅存本机凭据库' }).height(48).type(InputType.Password)
              .onChange((value: string) => { this.clientSecret = value; })
            ActionButton({ label: '开始授权', busy: this.busy, onTap: () => { this.begin(); } })
            if (this.busy) { ActionButton({ label: '取消准备', variant: 'quiet', onTap: () => { this.cancel(); } }) }
            ActionButton({ label: '退出此MCP授权', variant: 'secondary', isEnabled: !this.busy, onTap: () => { this.signOut(false); } })
            ActionButton({ label: '改用手填钥匙', variant: 'quiet', isEnabled: !this.busy, onTap: () => { this.signOut(true); } })
            if (this.message) { Text(this.message).fontSize(14).fontColor(Tokens.secondary).copyOption(CopyOptions.InApp) }
          }.width('100%').constraintSize({ maxWidth: 560 }).alignItems(HorizontalAlign.Start).padding(24)
        }.layoutWeight(1)
      } else {
        Column({ space: 8 }) {
          Text('授权服务器 ' + this.issuerName).fontSize(14).fontColor(Tokens.secondary)
          Row({ space: 10 }) {
            ActionButton({ label: '在系统浏览器继续', variant: 'secondary', fullWidth: false, onTap: () => { this.openBrowser(); } })
            ActionButton({ label: '取消授权', variant: 'quiet', fullWidth: false, onTap: () => { this.cancel(); } })
          }
          if (this.message) { Text(this.message).fontSize(13).fontColor(Tokens.secondary) }
        }.width('100%').padding(12)
        Web({ src: this.authorizationURL, controller: this.controller }).javaScriptAccess(true).domStorageAccess(true)
          .databaseAccess(false).fileAccess(false).mixedMode(MixedMode.None)
          .onOverrideUrlLoading((request) => { return this.navigation(request.getRequestUrl()); })
          .onPermissionRequest((event) => { event?.request.deny(); })
          .onErrorReceive(() => { this.message = '授权页面暂未加载，可检查网络或在系统浏览器继续'; })
          .layoutWeight(1)
      }
    }.width('100%').height('100%').backgroundColor(Tokens.grouped)

    }
    .hideTitleBar(true)
    .onShown(() => { AppNavigation.changed(); })
  }
  private async begin(): Promise<void> {
    this.cancel(); const generation = this.generation; this.busy = true; this.message = '';
    try {
      const row = mcpStore.find(this.label);
      if (!row || row.transport !== 'http') { throw new Error('此MCP配置已改变或不是HTTP服务器'); }
      const source = row.url; const reference = row.secretRef;
      const resource = JSON.parse(envStore.expand(JSON.stringify(source))) as string;
      oauthResource(resource); oauthRedirect(this.redirectURI);
      const current = (): boolean => {
        const latest = mcpStore.find(this.label);
        return this.active && generation === this.generation && latest !== null && latest.url === source && latest.secretRef === reference &&
          JSON.parse(envStore.expand(JSON.stringify(latest.url))) === resource;
      };
      const config = new McpOAuthConfig(); config.clientId = this.clientId; config.issuer = this.issuer;
      config.authorizationEndpoint = this.authorizationEndpoint; config.tokenEndpoint = this.tokenEndpoint; config.redirectURI = this.redirectURI; config.scopes = this.scopes;
      const session = await McpOAuth.begin(this.label, resource, config, this.clientSecret, current);
      if (!current()) { session.cancel(); return; }
      this.session = session; this.clientSecret = ''; this.issuerName = new url.URL(session.config.issuer).hostname;
      session.onComplete = () => { if (current()) { this.authorizationURL = ''; this.message = '授权已完成，MCP调用会使用此资源的令牌'; this.session = null; } };
      session.onError = (message: string) => { if (current()) { this.message = message; this.authorizationURL = ''; this.session = null; } };
      this.authorizationURL = session.authorizationURL;
    } catch (err) { if (this.active && generation === this.generation) { this.message = `${err}`; } }
    finally { if (generation === this.generation) { this.busy = false; } }
  }
  private navigation(target: string): boolean {
    const session = this.session;
    if (session) {
      try {
        const actual = new url.URL(target); const expected = oauthRedirect(session.config.redirectURI);
        if (actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname) {
          if (session.accepts(target)) { session.consume(target).catch(() => {}); }
          else { this.message = '已忽略不属于本次授权的回调'; }
          return true;
        }
      } catch (_err) { return true; }
    }
    try { return new url.URL(target).protocol !== 'https:'; } catch (_err) { return true; }
  }
  private openBrowser(): void {
    if (!this.authorizationURL) { return; }
    const context = getContext(this) as common.UIAbilityContext;
    context.startAbility({ action: 'ohos.want.action.viewData', uri: this.authorizationURL })
      .catch(() => { this.message = '系统浏览器未能打开，请在当前页面继续'; });
  }
  private cancel(): void {
    this.generation++; this.session?.cancel(); this.session = null; McpOAuth.cancel(this.label); this.authorizationURL = ''; this.busy = false;
  }
  private async signOut(manual: boolean): Promise<void> {
    this.cancel(); this.busy = true;
    try { await McpOAuth.signOut(this.label, manual); this.message = manual ? '已切回手填钥匙' : 'OAuth已退出，下一次调用需要重新授权'; }
    catch (_err) { this.message = '退出授权失败，请重试'; } finally { this.busy = false; }
  }
}
