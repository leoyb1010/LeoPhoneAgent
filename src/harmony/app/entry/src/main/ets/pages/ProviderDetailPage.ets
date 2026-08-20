import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { kindByKey } from '../local/ProviderCatalog';
import { BrowserOAuth } from '../local/BrowserOAuth';
import { DeviceOAuth } from '../local/DeviceOAuth';
import { DeviceAuth } from '../local/LocalProtocol';
import { OAuthLoginSheet } from '../local/OAuthLoginSheet';
import { OAuthSession } from '../local/OAuthSession';
import { skipUpstreamModels } from '../local/ProviderModels';
import { ProviderInstance, ProviderLaunch, providerStore } from '../store/ProviderStore';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct ProviderDetailPage {
  @StorageProp('themeTick') tick: number = 0;
  @State label: string = '';
  @State root: string = '';
  @State keyDraft: string = '';
  @State model: string = '';
  @State models: string[] = [];
  @State customModel: string = '';
  @State isOn: boolean = true;
  @State appendV1: boolean = true;
  @State azureMode: boolean = false;
  @State message: string = '';
  @State type: string = 'custom';
  @State credential: string = 'apiKey';
  @State showSecret: boolean = false;
  @State fromAdd: boolean = false;
  @State isActive: boolean = false;
  @State authUrl: string = '';
  @State userCode: string = '';
  @State oauthBusy: boolean = false;
  private rowId: string = '';

  aboutToAppear(): void {
    this.rowId = ProviderLaunch.id;
    this.fromAdd = ProviderLaunch.fromAdd;
    ProviderLaunch.fromAdd = false;
    const ctx = getContext(this) as common.UIAbilityContext;
    providerStore.ensureLoaded(ctx).then(() => {
      let row: ProviderInstance | null = null;
      for (let i = 0; i < providerStore.instances.length; i++) {
        if (providerStore.instances[i].id === this.rowId) {
          row = providerStore.instances[i];
          break;
        }
      }
      if (!row) {
        this.message = '供应商不在了';
        return;
      }
      this.label = row.label;
      this.type = row.type;
      this.credential = row.credential.length > 0 ? row.credential : 'apiKey';
      this.root = row.baseUrl;
      this.model = row.model;
      this.models = row.models.slice();
      this.isOn = row.enabled;
      this.appendV1 = row.appendV1;
      this.azureMode = row.azureMode;
      this.keyDraft = providerStore.keyFor(row.id);
      this.isActive = providerStore.activeId === this.rowId;
      if (this.fromAdd) {
        this.message = this.isActive ? '已设为当前供应商。选一个模型再保存，就能去聊天和执行任务。' :
          '选一个模型，打开「用作当前供应商」，再保存。';
      }
    });
  }

  aboutToDisappear(): void {
    DeviceOAuth.cancelWait();
    BrowserOAuth.cancel();
  }

  build() {
    if (this.authUrl.length > 0) {
      OAuthLoginSheet({
        authUrl: this.authUrl,
        userCode: this.userCode,
        providerType: this.type,
        onCapture: (url: string) => {
          return BrowserOAuth.take(url);
        },
        onClose: () => {
          DeviceOAuth.cancelWait();
          BrowserOAuth.cancel();
          this.authUrl = '';
          this.oauthBusy = false;
          this.message = '已取消登录';
        },
        onError: (text: string) => {
          this.message = text;
        }
      })
    } else {
      this.detail()
    }
  }

  @Builder
  detail() {
    Column() {
      Scroll() {
        Column() {
          Text(this.label.length > 0 ? this.label : '供应商')
            .fontSize(Tokens.title)
            .fontWeight(FontWeight.Bold)
            .fontColor(Tokens.text)
            .width('100%')
            .padding({ bottom: 4 })
          Text(`${kindByKey(this.type).title} · ${this.credential === 'oauth' ? 'OAuth' : 'API Key'}`)
            .fontSize(13)
            .fontColor(Tokens.muted)
            .width('100%')
            .padding({ bottom: 12 })
          if (this.fromAdd) {
            Text('下一步：选模型 → 确认当前供应商 → 保存')
              .fontSize(13)
              .fontColor(Tokens.link)
              .width('100%')
              .padding({ bottom: 12 })
          }
          this.fieldCaption('显示名')
          TextInput({ text: this.label })
            .onChange((value: string) => {
              this.label = value;
            })
            .height(44)
            .backgroundColor(Tokens.surface)
            .fontColor(Tokens.text)
            .borderRadius(Tokens.settingsRadius)
          this.fieldCaption('API 根')
          TextInput({ text: this.root, placeholder: kindByKey(this.type).root })
            .onChange((value: string) => {
              this.root = value;
            })
            .height(44)
            .backgroundColor(Tokens.surface)
            .fontColor(Tokens.text)
            .borderRadius(Tokens.settingsRadius)
          if (this.credential === 'oauth') {
            this.fieldCaption('OAuth')
            Text(this.keyDraft.length > 0 ? '已登录，钥匙存在本机' : '还没登录')
              .fontSize(Tokens.rowTitle)
              .fontColor(this.keyDraft.length > 0 ? Tokens.online : Tokens.warn)
              .padding({ bottom: 8 })
            if (BrowserOAuth.networkHint(this.type).length > 0) {
              Text(BrowserOAuth.networkHint(this.type))
                .fontSize(12)
                .fontColor(Tokens.warn)
                .padding({ bottom: 8 })
            }
            Button('重新登录')
              .width('100%')
              .height(40)
              .backgroundColor(Tokens.surface2)
              .fontColor(Tokens.text)
              .enabled(!this.oauthBusy)
              .onClick(() => {
                this.beginOAuth();
              })
          } else {
            this.fieldCaption('API Key')
            Row() {
              TextInput({ text: this.keyDraft, placeholder: '留空则不改已存钥匙' })
                .type(this.showSecret ? InputType.Normal : InputType.Password)
                .onChange((value: string) => {
                  this.keyDraft = value;
                })
                .layoutWeight(1)
                .height(44)
                .backgroundColor(Tokens.surface)
                .fontColor(Tokens.text)
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
          this.fieldCaption('当前模型')
          TextInput({ text: this.model, placeholder: '点下面列表，或在这里手填' })
            .onChange((value: string) => {
              this.model = value;
            })
            .height(44)
            .backgroundColor(Tokens.surface)
            .fontColor(Tokens.text)
            .borderRadius(Tokens.settingsRadius)
          if (skipUpstreamModels(this.type, this.credential)) {
            Text('OpenAI OAuth / Codex 没有 /models 列表，用内置模型即可。')
              .fontSize(12)
              .fontColor(Tokens.muted)
              .padding({ top: 10, bottom: 4 })
          } else {
            Button('从上游拉取 /models')
              .width('100%')
              .height(40)
              .margin({ top: 12 })
              .backgroundColor(Tokens.surface2)
              .fontColor(Tokens.text)
              .onClick(() => {
                this.pullModels();
              })
          }
          Row() {
            Text('用作当前供应商')
              .fontSize(Tokens.rowTitle)
              .fontColor(Tokens.text)
              .layoutWeight(1)
            Toggle({ type: ToggleType.Switch, isOn: this.isActive })
              .onChange((on: boolean) => {
                if (on) {
                  this.makeActive();
                }
              })
          }
          .width('100%')
          .padding({ top: 16, bottom: 8 })
          Row() {
            Text('启用')
              .fontSize(Tokens.rowTitle)
              .fontColor(Tokens.text)
              .layoutWeight(1)
            Toggle({ type: ToggleType.Switch, isOn: this.isOn })
              .onChange((on: boolean) => {
                this.isOn = on;
              })
          }
          .width('100%')
          .padding({ bottom: 8 })
          if (this.models.length > 0) {
            List() {
              ForEach(this.models, (id: string) => {
                ListItem() {
                  this.modelRow(id)
                }
              }, (id: string) => id)
            }
            .width('100%')
            .constraintSize({ maxHeight: 240 })
            .backgroundColor(Tokens.surface)
            .borderRadius(Tokens.settingsRadius)
            .clip(true)
            .scrollBar(BarState.Off)
            .edgeEffect(EdgeEffect.None)
          }
          TextInput({ text: this.customModel, placeholder: '追加模型 id' })
            .onChange((value: string) => {
              this.customModel = value;
            })
            .height(44)
            .margin({ top: 8 })
            .backgroundColor(Tokens.surface)
            .fontColor(Tokens.text)
            .borderRadius(Tokens.settingsRadius)
          Button('删除这个供应商')
            .width('100%')
            .height(44)
            .margin({ top: 12, bottom: 12 })
            .backgroundColor(Tokens.surface2)
            .fontColor(Tokens.accent)
            .onClick(() => {
              this.remove();
            })
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 12, bottom: 16 })
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.Top)
      .scrollBar(BarState.Off)
      Column() {
        if (this.message.length > 0) {
          Text(this.message)
            .fontSize(13)
            .fontColor(this.message === '已保存' || this.message.indexOf('已设为') >= 0 ||
              this.message.indexOf('已拉取') >= 0 ?
              Tokens.online : Tokens.warn)
            .width('100%')
            .padding({ bottom: 8 })
        }
        Button('保存')
          .width('100%')
          .height(44)
          .backgroundColor(Tokens.accent)
          .fontColor('#FFFFFF')
          .onClick(() => {
            this.save();
          })
      }
      .width('100%')
      .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 8, bottom: 16 })
      .backgroundColor(Tokens.bg)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }

  @Builder
  fieldCaption(title: string) {
    Text(title)
      .fontSize(13)
      .fontColor(Tokens.muted)
      .width('100%')
      .padding({ top: 14, bottom: 6 })
  }

  @Builder
  modelRow(id: string) {
    Row() {
      Text(id)
        .fontSize(15)
        .fontColor(this.model === id ? Tokens.link : Tokens.text)
        .fontWeight(this.model === id ? FontWeight.Medium : FontWeight.Regular)
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      if (this.model === id) {
        Text('已选')
          .fontSize(12)
          .fontColor(Tokens.link)
      }
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 12, bottom: 12 })
    .backgroundColor(this.model === id ? Tokens.surface2 : '#00000000')
    .onClick(() => {
      this.model = id;
      this.customModel = '';
    })
  }

  private current(): ProviderInstance {
    const row = new ProviderInstance();
    row.id = this.rowId;
    row.label = this.label;
    row.type = this.type;
    row.credential = this.credential;
    row.baseUrl = this.root;
    row.model = this.customModel.trim().length > 0 ? this.customModel.trim() : this.model;
    row.models = this.models.slice();
    if (row.model.length > 0 && row.models.indexOf(row.model) < 0) {
      row.models = [row.model].concat(row.models);
    }
    row.enabled = this.isOn;
    row.appendV1 = this.appendV1;
    row.azureMode = this.azureMode;
    return row;
  }

  private async save(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      await providerStore.upsert(ctx, this.current(), this.keyDraft);
      this.isActive = providerStore.activeId === this.rowId;
      this.message = '已保存';
    } catch (err) {
      this.message = `${err}`;
    }
  }

  private async makeActive(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    await providerStore.setActive(ctx, this.rowId);
    this.isActive = true;
  }

  private async pullModels(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      await providerStore.ensureLoaded(ctx);
      const row = this.current();
      if (this.keyDraft.trim().length > 0) {
        await providerStore.upsert(ctx, row, this.keyDraft);
      }
      let live: ProviderInstance | null = null;
      for (let i = 0; i < providerStore.instances.length; i++) {
        if (providerStore.instances[i].id === this.rowId) {
          live = providerStore.instances[i];
          break;
        }
      }
      if (!live) {
        throw new Error('先保存再拉模型');
      }
      this.models = await providerStore.refreshModels(live);
      this.model = live.model;
      await providerStore.save(ctx);
      this.message = `已拉取 ${this.models.length} 个模型`;
    } catch (err) {
      this.message = `${err}`;
    }
  }

  private async beginOAuth(): Promise<void> {
    if (this.oauthBusy) {
      return;
    }
    this.oauthBusy = true;
    this.message = '正在打开登录';
    try {
      if (this.type === 'kimiCode' || this.type === 'xAI') {
        const auth: DeviceAuth = await DeviceOAuth.start(this.type);
        this.userCode = auth.userCode;
        this.authUrl = auth.verificationUri;
        this.keyDraft = await DeviceOAuth.wait(this.type, auth);
      } else {
        this.authUrl = await BrowserOAuth.begin(this.type);
        const callback = await BrowserOAuth.waitCapture();
        this.keyDraft = await BrowserOAuth.exchange(this.type, callback);
      }
      const ctx = getContext(this) as common.UIAbilityContext;
      await providerStore.upsert(ctx, this.current(), this.keyDraft);
      await OAuthSession.bind(this.rowId);
      this.message = '已重新登录';
    } catch (err) {
      this.message = `${err}`;
    }
    this.authUrl = '';
    this.userCode = '';
    this.oauthBusy = false;
  }

  private async remove(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      await providerStore.remove(ctx, this.rowId);
      router.back();
    } catch (err) {
      this.message = `${err}`;
    }
  }
}
