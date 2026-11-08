import { AppNavigation } from '../navigation/AppNavigation';
import { common } from '@kit.AbilityKit';

import { inputMethod } from '@kit.IMEKit';
import {
  defaultAppendV1,
  keyHint,
  kindByKey,
  providerKinds,
  ProviderKind
} from '../local/ProviderCatalog';
import { BrowserOAuth } from '../local/BrowserOAuth';
import { DeviceOAuth } from '../local/DeviceOAuth';
import { OAuthSession } from '../local/OAuthSession';
import { OAuthLoginSheet } from '../local/OAuthLoginSheet';
import { DeviceAuth } from '../local/LocalProtocol';
import { VoiceTemplate, voiceCapabilityLabel, voiceTemplates } from '../local/VoiceCatalog';
import { ProviderInstance, ProviderLaunch, providerStore } from '../store/ProviderStore';
import { NavBar, SettingsRow } from '../theme/Widgets';
import { ActionButton } from '../theme/Controls';
import { Tokens } from '../theme/Tokens';

@Component
export struct AddProviderPage {
  @StorageProp('themeTick') tick: number = 0;
  @State step: number = 0;
  @State saving: boolean = false;
  @State type: string = '';
  @State credential: string = 'apiKey';
  @State methods: string[] = [];
  @State label: string = '';
  @State root: string = '';
  @State keyDraft: string = '';
  @State showSecret: boolean = false;
  @State appendV1: boolean = true;
  @State azureMode: boolean = false;
  @State message: string = '';
  @State userCode: string = '';
  @State authUrl: string = '';
  @State oauthBusy: boolean = false;
  @State signedIn: boolean = false;
  @State voiceNote: string = '';
  @State seedModels: string[] = [];

  build() {
    NavDestination() {
    Column() {
      if (this.authUrl.length > 0) {
        OAuthLoginSheet({
          authUrl: this.authUrl,
          userCode: this.userCode,
          providerType: this.type,
          onCapture: (url: string) => {
            return this.capture(url);
          },
          onClose: () => {
            this.stopOAuth();
            this.authUrl = '';
            this.oauthBusy = false;
            this.message = '已取消登录';
          },
          onError: (text: string) => {
            this.message = text;
          }
        })
      } else {
        NavBar({
          title: this.header(),
          action: this.step > 0 ? '上一步' : '',
          onAction: () => {
            this.backStep();
          }
        })
        if (this.step === 0) {
          this.chooseType()
        } else if (this.step === 1) {
          this.chooseCredential()
        } else {
          this.configure()
        }
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)

    }
    .hideTitleBar(true)
    .onShown(() => { AppNavigation.changed(); })
  }

  aboutToDisappear(): void {
    this.stopOAuth();
  }

  @Builder
  chooseType() {
    Scroll() {
      Column({ space: 12 }) {
        Text('选择服务商后，连接你的账号或 API Key。').fontSize(14).fontColor(Tokens.secondary).width('100%')
        Column() {
          ForEach(providerKinds(), (kind: ProviderKind, index: number) => {
            SettingsRow({ mark: kind.mark, color: kind.color, title: kind.title,
              subtitle: BrowserOAuth.methodLabel(kind.key), divider: index > 0, onOpen: () => this.pick(kind) })
          }, (kind: ProviderKind) => kind.key)
        }.width('100%').backgroundColor(Tokens.card).borderRadius(16).clip(true)
        Text('语音服务商').fontSize(13).fontColor(Tokens.secondary).width('100%').margin({ top: 16 })
        Column() {
          ForEach(voiceTemplates(), (tpl: VoiceTemplate, index: number) => {
            SettingsRow({ icon: 'mic', color: Tokens.secondary, title: tpl.name,
              subtitle: voiceCapabilityLabel(tpl.capability) + ' · 预填地址和模型', divider: index > 0, onOpen: () => this.pickVoice(tpl) })
          }, (tpl: VoiceTemplate) => tpl.id)
        }.width('100%').backgroundColor(Tokens.card).borderRadius(16).clip(true)
      }.width('100%').constraintSize({ maxWidth: 640 }).padding({ left: 20, right: 20, top: 12, bottom: 32 })
    }.width('100%').layoutWeight(1).align(Alignment.Top).scrollBar(BarState.Off).backgroundColor(Tokens.grouped)
  }

  @Builder
  chooseCredential() {
    Scroll() {
      Column({ space: 12 }) {
        Text('连接方式').fontSize(14).fontColor(Tokens.secondary).width('100%')
        Column() {
          ForEach(this.methods, (method: string, index: number) => {
            SettingsRow({ icon: method === 'oauth' ? 'globe_badge_message' : 'lock', color: Tokens.accent,
              title: method === 'oauth' ? 'OAuth 登录' : 'API Key',
              subtitle: method === 'oauth' ? BrowserOAuth.oauthHint(this.type) : BrowserOAuth.keyHint(this.type),
              divider: index > 0, onOpen: () => this.pickCredential(method) })
          }, (method: string) => method)
        }.width('100%').backgroundColor(Tokens.card).borderRadius(16).clip(true)
      }.width('100%').constraintSize({ maxWidth: 560 }).padding({ left: 20, right: 20, top: 12, bottom: 32 })
    }.width('100%').layoutWeight(1).align(Alignment.Top).scrollBar(BarState.Off).backgroundColor(Tokens.grouped)
  }

  @Builder
  configure() {
    Column() {
      Scroll() {
        Column() {
          this.section('身份')
          this.field('显示名', this.label, kindByKey(this.type).title, (value: string) => {
            this.label = value;
          })
          if (this.credential === 'oauth') {
            this.oauthBlock()
          } else {
            this.section('凭证')
            this.secret()
          }
          if (this.type !== 'openRouter') {
            this.section('接口')
            this.field('自定义 API 根（可空）', this.root, kindByKey(this.type).root, (value: string) => {
              this.root = value;
            })
            if (this.type !== 'gemini') {
              Row() {
                Text('根路径自动补 /v1')
                  .fontSize(Tokens.rowTitle)
                  .fontColor(Tokens.text)
                  .layoutWeight(1)
                Toggle({ type: ToggleType.Switch, isOn: this.appendV1 })
                  .onChange((on: boolean) => {
                    this.appendV1 = on;
                  })
              }
              .width('100%')
              .padding({ top: 12, bottom: 8 })
            }
            if (this.type === 'openAI') {
              Row() {
                Text('Azure OpenAI')
                  .fontSize(Tokens.rowTitle)
                  .fontColor(Tokens.text)
                  .layoutWeight(1)
                Toggle({ type: ToggleType.Switch, isOn: this.azureMode })
                  .onChange((on: boolean) => {
                    this.azureMode = on;
                  })
              }
              .width('100%')
              .padding({ top: 4, bottom: 8 })
            }
            if (this.type === 'openCodeGo') {
              Text('在 opencode.ai/auth 登录后复制 API Key（需要 OpenCode Go 会员）。根地址保持默认即可。')
                .fontSize(12)
                .fontColor(Tokens.muted)
                .padding({ top: 4, bottom: 8 })
            }
            if (this.type === 'anthropic') {
              Text('填 Anthropic 控制台的 API Key，直连 api.anthropic.com 走官方 Messages API。Claude 订阅登录不再提供：要用订阅，远控 Mac 上你自己登录的官方 claude。')
                .fontSize(12)
                .fontColor(Tokens.muted)
                .padding({ top: 4, bottom: 8 })
            }
          }
          if (this.voiceNote.length > 0) {
            Text(this.voiceNote)
              .fontSize(12)
              .fontColor(Tokens.muted)
              .padding({ top: 4, bottom: 8 })
          }
          if (this.message.length > 0) {
            Text(this.message)
              .fontSize(13)
              .fontColor(Tokens.warn)
              .padding({ top: 8, bottom: 8 })
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .constraintSize({ maxWidth: 560 })
        .padding({ left: 20, right: 20, bottom: 20 })
      }
      .layoutWeight(1)
      .align(Alignment.Top)
      .scrollBar(BarState.Off)
      ActionButton({ label: '添加 AI 服务商', busy: this.saving, isEnabled: !this.oauthBusy && this.keyDraft.trim().length > 0,
        onTap: () => this.save() }).width('100%').constraintSize({ maxWidth: 560 }).padding({ left: 20, right: 20 }).margin({ bottom: 20 })
    }
    .width('100%')
    .layoutWeight(1)

  }

  @Builder
  oauthBlock() {
    this.section('凭证')
    if (this.signedIn && this.keyDraft.length > 0) {
      Text('已登录，钥匙存在本机')
        .fontSize(Tokens.rowTitle)
        .fontColor(Tokens.online)
        .padding({ bottom: 8 })
      Text(this.maskedToken(this.keyDraft))
        .fontSize(12)
        .fontColor(Tokens.muted)
        .padding({ bottom: 8 })
    } else {
      Text(BrowserOAuth.oauthHint(this.type))
        .fontSize(13)
        .fontColor(Tokens.muted)
        .padding({ bottom: 8 })
      if (BrowserOAuth.networkHint(this.type).length > 0) {
        Text(BrowserOAuth.networkHint(this.type))
          .fontSize(12)
          .fontColor(Tokens.warn)
          .padding({ bottom: 10 })
      }
      ActionButton({ label: BrowserOAuth.signInLabel(this.type), busy: this.oauthBusy, onTap: () => this.beginOAuth() })
    }
  }

  @Builder
  section(title: string) {
    Text(title)
      .fontSize(13)
      .fontColor(Tokens.muted)
      .width('100%')
      .padding({ top: 18, bottom: 8 })
  }

  @Builder
  field(title: string, value: string, hint: string, onChange: (v: string) => void) {
    Text(title)
      .fontSize(13)
      .fontColor(Tokens.muted)
      .padding({ bottom: 6 })
    TextInput({ text: value, placeholder: hint })
      .onChange(onChange)
      .accessibilityText(title)
      .height(48)
      .backgroundColor(Tokens.surface)
      .fontColor(Tokens.text)
      .placeholderColor(Tokens.muted)
      .borderRadius(Tokens.settingsRadius)
  }

  @Builder
  secret() {
    Text('API Key')
      .fontSize(13)
      .fontColor(Tokens.muted)
      .padding({ bottom: 6 })
    Row() {
      TextInput({ text: this.keyDraft, placeholder: keyHint(this.type) })
        .type(this.showSecret ? InputType.Normal : InputType.Password)
        .accessibilityText('API Key')
        .enableAutoFill(false)
        .onChange((value: string) => {
          this.keyDraft = value;
        })
        .layoutWeight(1)
        .height(44)
        .backgroundColor(Tokens.surface)
        .fontColor(Tokens.text)
        .placeholderColor(Tokens.muted)
        .borderRadius(Tokens.settingsRadius)
      ActionButton({ label: this.showSecret ? '隐藏' : '显示', variant: 'quiet', fullWidth: false,
        onTap: () => { this.showSecret = !this.showSecret; } })
    }
    .width('100%')
  }

  private header(): string {
    if (this.step === 0) {
      return '选择 AI 服务商';
    }
    if (this.step === 1) {
      return '选择凭证';
    }
    return `配置 ${kindByKey(this.type).title}`;
  }

  private pick(kind: ProviderKind): void {
    this.type = kind.key;
    this.label = providerStore.nextLabel(kind.key);
    this.root = '';
    this.appendV1 = defaultAppendV1(kind.key);
    this.azureMode = false;
    this.credential = 'apiKey';
    this.signedIn = false;
    this.keyDraft = '';
    this.voiceNote = '';
    this.seedModels = [];
    this.methods = BrowserOAuth.available(kind.key);
    if (this.methods.length === 1) {
      this.credential = this.methods[0];
      this.step = 2;
    } else {
      this.step = 1;
    }
  }

  private pickVoice(tpl: VoiceTemplate): void {
    this.type = tpl.providerType;
    this.label = tpl.name;
    this.root = tpl.baseURL;
    this.appendV1 = tpl.appendV1;
    this.azureMode = false;
    this.credential = 'apiKey';
    this.signedIn = false;
    this.keyDraft = '';
    this.voiceNote = tpl.note;
    this.seedModels = tpl.models.slice();
    this.methods = ['apiKey'];
    this.step = 2;
  }

  private pickCredential(method: string): void {
    this.credential = method;
    this.signedIn = false;
    this.keyDraft = '';
    this.message = '';
    this.step = 2;
  }

  private backStep(): void {
    this.stopOAuth();
    this.oauthBusy = false;
    this.authUrl = '';
    if (this.step === 2 && this.methods.length === 1) {
      this.step = 0;
      return;
    }
    this.step -= 1;
  }

  private capture(url: string): boolean {
    return BrowserOAuth.take(url);
  }

  private stopOAuth(): void {
    DeviceOAuth.cancelWait();
    BrowserOAuth.cancel();
  }

  private async beginOAuth(): Promise<void> {
    if (this.oauthBusy) {
      return;
    }
    this.oauthBusy = true;
    this.message = '正在打开登录';
    try {
      if (this.type === 'kimiCode' || this.type === 'xAI') {
        await this.beginDevice();
      } else {
        await this.beginBrowser();
      }
      this.signedIn = this.keyDraft.length > 0;
      if (this.signedIn) {
        this.message = '已登录，保存后会进入选模型';
      }
    } catch (err) {
      this.message = `${err}`;
    }
    this.authUrl = '';
    this.userCode = '';
    this.oauthBusy = false;
  }

  private async beginDevice(): Promise<void> {
    const auth: DeviceAuth = await DeviceOAuth.start(this.type);
    this.userCode = auth.userCode;
    this.authUrl = auth.verificationUri;
    this.message = `打开页面，输入 ${auth.userCode}`;
    this.keyDraft = await DeviceOAuth.wait(this.type, auth);
  }

  private async beginBrowser(): Promise<void> {
    this.authUrl = await BrowserOAuth.begin(this.type);
    const callback = await BrowserOAuth.waitCapture();
    this.keyDraft = await BrowserOAuth.exchange(this.type, callback);
  }

  private maskedToken(token: string): string {
    if (token.length <= 10) {
      return '••••';
    }
    return `${token.substring(0, 6)}…${token.substring(token.length - 4)}`;
  }

  private async save(): Promise<void> {
    if (this.saving || !this.keyDraft.trim()) return;
    this.saving = true;
    try {
      await inputMethod.getController().stopInputSession();
    } catch (_err) {
      // keyboard optional
    }
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      const kind = kindByKey(this.type);
      const row = new ProviderInstance();
      row.id = `p_${Date.now()}`;
      row.label = this.label.trim() || providerStore.nextLabel(this.type);
      row.type = this.type;
      row.credential = this.credential;
      row.baseUrl = this.type === 'openRouter' ? kind.root : this.root.trim();
      row.model = kind.models.length > 0 ? kind.models[0] : '';
      if (this.seedModels.length > 0) {
        row.models = this.seedModels.slice();
        row.model = this.seedModels[0];
      } else {
        row.models = kind.models.slice();
      }
      if (this.type === 'openAI' && this.credential === 'oauth' && kind.models.indexOf('gpt-5.3-codex') >= 0) {
        row.model = 'gpt-5.3-codex';
      }
      row.appendV1 = this.type === 'gemini' ? false : this.appendV1;
      row.azureMode = this.azureMode;
      row.createdAt = Date.now();
      await providerStore.upsert(ctx, row, this.keyDraft);
      await OAuthSession.bind(row.id, this.keyDraft);
      try {
        await providerStore.refreshModels(ctx, row.id);
      } catch (_err) {
        // keep built-in list if upstream is down
      }
      ProviderLaunch.id = row.id;
      ProviderLaunch.fromAdd = true;
      this.message = '已保存，正在进入选模型';
      await AppNavigation.replaceUrl({ url: 'pages/ProviderDetailPage' });
    } catch (err) {
      this.message = `${err}`;
    } finally { this.saving = false; }
  }
}
