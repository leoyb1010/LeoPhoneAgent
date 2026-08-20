import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { inputMethod } from '@kit.ImeKit';
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
import { IconCircle } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct AddProviderPage {
  @StorageProp('themeTick') tick: number = 0;
  @State step: number = 0;
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
        Row() {
          Text(this.header())
            .fontSize(Tokens.title)
            .fontWeight(FontWeight.Bold)
            .fontColor(Tokens.text)
          Blank()
          if (this.step > 0) {
            Text('上一步')
              .fontSize(13)
              .fontColor(Tokens.link)
              .onClick(() => {
                this.backStep();
              })
          }
        }
        .width('100%')
        .height(Tokens.topBar)
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad })
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

  aboutToDisappear(): void {
    this.stopOAuth();
  }

  @Builder
  chooseType() {
    Scroll() {
      Column() {
        Text('先选类型。下一步按这一家列出能用的登录方式。')
          .fontSize(13)
          .fontColor(Tokens.muted)
          .width('100%')
          .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 12 })
        Column() {
          ForEach(providerKinds(), (kind: ProviderKind) => {
            Row() {
              IconCircle({
                box: Tokens.settingsIcon,
                glyph: Tokens.settingsGlyph,
                color: kind.color,
                mark: kind.mark
              })
              Column() {
                Text(kind.title)
                  .fontSize(Tokens.rowTitle)
                  .fontColor(Tokens.text)
                Text(BrowserOAuth.methodLabel(kind.key))
                  .fontSize(12)
                  .fontColor(Tokens.muted)
                  .margin({ top: 2 })
              }
              .alignItems(HorizontalAlign.Start)
              .margin({ left: Tokens.rowGap })
              .layoutWeight(1)
              Text('›')
                .fontSize(18)
                .fontColor(Tokens.muted)
            }
            .width('100%')
            .padding({ left: 14, right: 14, top: 12, bottom: 12 })
            .onClick(() => {
              this.pick(kind);
            })
          }, (kind: ProviderKind) => kind.key)
        }
        .width('100%')
        .backgroundColor(Tokens.surface)
        .borderRadius(Tokens.settingsRadius)
        .margin({ left: Tokens.pagePad, right: Tokens.pagePad })
        Text('语音供应商模板')
          .fontSize(13)
          .fontColor(Tokens.muted)
          .width('100%')
          .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 18, bottom: 8 })
        Column() {
          ForEach(voiceTemplates(), (tpl: VoiceTemplate) => {
            Row() {
              IconCircle({
                box: Tokens.settingsIcon,
                glyph: Tokens.settingsGlyph,
                color: '#8E8E93',
                icon: 'voice'
              })
              Column() {
                Text(tpl.name)
                  .fontSize(Tokens.rowTitle)
                  .fontColor(Tokens.text)
                Text(`${voiceCapabilityLabel(tpl.capability)} · 预填根和模型`)
                  .fontSize(12)
                  .fontColor(Tokens.muted)
                  .margin({ top: 2 })
              }
              .alignItems(HorizontalAlign.Start)
              .margin({ left: Tokens.rowGap })
              .layoutWeight(1)
              Text('›')
                .fontSize(18)
                .fontColor(Tokens.muted)
            }
            .width('100%')
            .padding({ left: 14, right: 14, top: 12, bottom: 12 })
            .onClick(() => {
              this.pickVoice(tpl);
            })
          }, (tpl: VoiceTemplate) => tpl.id)
        }
        .width('100%')
        .backgroundColor(Tokens.surface)
        .borderRadius(Tokens.settingsRadius)
        .margin({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 32 })
      }
      .width('100%')
    }
    .layoutWeight(1)
    .align(Alignment.Top)
    .scrollBar(BarState.Off)
  }

  @Builder
  chooseCredential() {
    Scroll() {
      Column() {
        Text('怎么登录')
          .fontSize(13)
          .fontColor(Tokens.muted)
          .width('100%')
          .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 8 })
        Column() {
          ForEach(this.methods, (method: string) => {
            Row() {
              IconCircle({
                box: Tokens.settingsIcon,
                glyph: Tokens.settingsGlyph,
                color: '#007AFF',
                icon: method === 'oauth' ? 'web' : 'edit'
              })
              Column() {
                Text(method === 'oauth' ? 'OAuth' : 'API Key')
                  .fontSize(Tokens.rowTitle)
                  .fontColor(Tokens.text)
                Text(method === 'oauth' ? BrowserOAuth.oauthHint(this.type) : BrowserOAuth.keyHint(this.type))
                  .fontSize(12)
                  .fontColor(Tokens.muted)
                  .margin({ top: 2 })
              }
              .alignItems(HorizontalAlign.Start)
              .margin({ left: Tokens.rowGap })
              .layoutWeight(1)
              Text('›')
                .fontSize(18)
                .fontColor(Tokens.muted)
            }
            .width('100%')
            .padding({ left: 14, right: 14, top: 12, bottom: 12 })
            .onClick(() => {
              this.pickCredential(method);
            })
          }, (method: string) => method)
        }
        .width('100%')
        .backgroundColor(Tokens.surface)
        .borderRadius(Tokens.settingsRadius)
        .margin({ left: Tokens.pagePad, right: Tokens.pagePad })
      }
      .width('100%')
      .padding({ bottom: 32 })
    }
    .layoutWeight(1)
    .align(Alignment.Top)
    .scrollBar(BarState.Off)
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
            if (this.type === 'anthropic') {
              Text('官方 Messages API 这一版走 OpenAI 兼容根。直连 api.anthropic.com 需要兼容网关。')
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
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 16 })
      }
      .layoutWeight(1)
      .align(Alignment.Top)
      .scrollBar(BarState.Off)
      Button('添加供应商')
        .width('100%')
        .height(44)
        .margin({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 20 })
        .backgroundColor(Tokens.accent)
        .fontColor('#FFFFFF')
        .enabled(this.keyDraft.trim().length > 0)
        .onClick(() => {
          this.save();
        })
    }
    .width('100%')
    .layoutWeight(1)
    .expandSafeArea([SafeAreaType.KEYBOARD], [SafeAreaEdge.BOTTOM])
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
      Button(BrowserOAuth.signInLabel(this.type))
        .width('100%')
        .height(44)
        .backgroundColor(Tokens.accent)
        .fontColor('#FFFFFF')
        .enabled(!this.oauthBusy)
        .onClick(() => {
          this.beginOAuth();
        })
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
      .height(44)
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
        .onChange((value: string) => {
          this.keyDraft = value;
        })
        .layoutWeight(1)
        .height(44)
        .backgroundColor(Tokens.surface)
        .fontColor(Tokens.text)
        .placeholderColor(Tokens.muted)
        .borderRadius(Tokens.settingsRadius)
      Text(this.showSecret ? '隐藏' : '显示')
        .fontSize(13)
        .fontColor(Tokens.link)
        .padding({ left: 10 })
        .onClick(() => {
          this.showSecret = !this.showSecret;
        })
    }
    .width('100%')
  }

  private header(): string {
    if (this.step === 0) {
      return '选择供应商';
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
    try {
      inputMethod.getController().stopInputSession();
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
      await OAuthSession.bind(row.id);
      try {
        row.models = await providerStore.refreshModels(row);
        await providerStore.save(ctx);
      } catch (_err) {
        // keep built-in list if upstream is down
      }
      ProviderLaunch.id = row.id;
      ProviderLaunch.fromAdd = true;
      this.message = '已保存，正在进入选模型';
      await router.replaceUrl({ url: 'pages/ProviderDetailPage' });
    } catch (err) {
      this.message = `${err}`;
    }
  }
}
