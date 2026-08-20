import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { kindByKey, providerKinds, ProviderKind } from '../local/ProviderCatalog';
import { ProviderInstance, ProviderLaunch, providerStore } from '../store/ProviderStore';
import { IconCircle } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct ProviderListPage {
  @StorageProp('themeTick') tick: number = 0;
  @State ready: boolean = false;
  @State message: string = '';
  @State rows: ProviderInstance[] = [];

  aboutToAppear(): void {
    this.refresh();
  }

  onPageShow(): void {
    this.refresh();
  }

  build() {
    Column() {
      Row() {
        Text('供应商')
          .fontSize(Tokens.title)
          .fontWeight(FontWeight.Bold)
          .fontColor(Tokens.text)
        Blank()
        Text('+ 添加')
          .fontSize(14)
          .fontColor(Tokens.link)
          .onClick(() => {
            router.pushUrl({ url: 'pages/AddProviderPage' });
          })
      }
      .width('100%')
      .height(Tokens.topBar)
      .padding({ left: Tokens.pagePad, right: Tokens.pagePad })
      Text('和 Fold8 一样：先选类型，再选 API Key 或 OAuth，再填模型和根。')
        .fontSize(13)
        .fontColor(Tokens.muted)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 12 })
      if (this.message.length > 0) {
        Text(this.message)
          .fontSize(13)
          .fontColor(Tokens.warn)
          .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 8 })
      }
      Scroll() {
        Column() {
          if (this.rows.length === 0) {
            this.empty()
          } else {
            ForEach(providerKinds(), (kind: ProviderKind) => {
              this.group(kind)
            }, (kind: ProviderKind) => kind.key)
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding({ bottom: 32 })
      }
      .layoutWeight(1)
      .align(Alignment.Top)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }

  @Builder
  group(kind: ProviderKind) {
    Column() {
      if (this.of(kind.key).length > 0) {
        Text(kind.title)
          .fontSize(Tokens.section)
          .fontColor(Tokens.muted)
          .width('100%')
          .padding({
            left: Tokens.pagePad,
            right: Tokens.pagePad,
            top: 12,
            bottom: 8
          })
        Column() {
          ForEach(this.of(kind.key), (row: ProviderInstance) => {
            this.row(row)
          }, (row: ProviderInstance) => row.id)
        }
        .width('100%')
        .backgroundColor(Tokens.surface)
        .borderRadius(Tokens.settingsRadius)
        .margin({ left: Tokens.pagePad, right: Tokens.pagePad })
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  row(row: ProviderInstance) {
    Row() {
      IconCircle({
        box: Tokens.settingsIcon,
        glyph: Tokens.settingsGlyph,
        color: kindByKey(row.type).color,
        mark: kindByKey(row.type).mark
      })
      Column() {
        Text(row.label.length > 0 ? row.label : kindByKey(row.type).title)
          .fontSize(Tokens.rowTitle)
          .fontColor(Tokens.text)
        Text(`${row.credential === 'oauth' ? 'OAuth' : 'API Key'} · ${row.model} · ${row.enabled ? '已启用' : '已关闭'}${providerStore.activeId === row.id ? ' · 当前' : ''}`)
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
      ProviderLaunch.id = row.id;
      router.pushUrl({ url: 'pages/ProviderDetailPage' });
    })
  }

  @Builder
  empty() {
    Column() {
      Text('还没有供应商')
        .fontSize(16)
        .fontColor(Tokens.text)
      Text('点右上角添加，先选 OpenAI / Anthropic / Gemini / xAI / Kimi / OpenRouter。')
        .fontSize(13)
        .fontColor(Tokens.muted)
        .textAlign(TextAlign.Center)
        .margin({ top: 8 })
    }
    .width('100%')
    .padding({ left: 24, right: 24, top: 48 })
    .alignItems(HorizontalAlign.Center)
  }

  private of(type: string): ProviderInstance[] {
    const out: ProviderInstance[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      if (this.rows[i].type === type) {
        out.push(this.rows[i]);
      }
    }
    return out;
  }

  private refresh(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    providerStore.ensureLoaded(ctx).then(() => {
      this.rows = providerStore.instances.slice();
      this.ready = true;
      if (providerStore.jsonLoadFailed) {
        this.message = '供应商档案读坏了，先别保存';
      }
    });
  }
}
