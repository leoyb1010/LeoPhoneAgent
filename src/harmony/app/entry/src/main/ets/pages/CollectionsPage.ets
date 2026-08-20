import { common } from '@kit.AbilityKit';
import { CollectionItem, collectionStore } from '../store/CollectionStore';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct CollectionsPage {
  @State title: string = '';
  @State body: string = '';
  @State rows: CollectionItem[] = [];
  @State message: string = '';

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    collectionStore.load(ctx).then(() => {
      this.rows = collectionStore.items.slice();
    });
  }

  build() {
    Column() {
      Text('藏宝阁')
        .fontSize(Tokens.title)
        .fontWeight(FontWeight.Bold)
        .fontColor(Tokens.text)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 12, bottom: 12 })
      Scroll() {
        Column() {
          TextInput({ text: this.title, placeholder: '标题' })
            .onChange((value: string) => {
              this.title = value;
            })
            .height(44)
            .backgroundColor(Tokens.surface)
            .fontColor(Tokens.text)
            .borderRadius(Tokens.settingsRadius)
          TextArea({ text: this.body, placeholder: '笔记、链接或摘录' })
            .onChange((value: string) => {
              this.body = value;
            })
            .height(100)
            .margin({ top: 8 })
            .backgroundColor(Tokens.surface)
            .fontColor(Tokens.text)
            .borderRadius(Tokens.settingsRadius)
          Button('收入藏宝阁')
            .width('100%')
            .height(44)
            .margin({ top: 12, bottom: 16 })
            .backgroundColor(Tokens.accent)
            .fontColor('#FFFFFF')
            .onClick(() => {
              const ctx = getContext(this) as common.UIAbilityContext;
              collectionStore.add(ctx, this.title, this.body).then(() => {
                this.rows = collectionStore.items.slice();
                this.title = '';
                this.body = '';
                this.message = '已收入';
              }).catch((err: Error) => {
                this.message = `${err}`;
              });
            })
          ForEach(this.rows, (row: CollectionItem) => {
            Column() {
              Text(row.title)
                .fontSize(Tokens.rowTitle)
                .fontColor(Tokens.text)
              Text(row.body)
                .fontSize(Tokens.rowSub)
                .fontColor(Tokens.muted)
                .margin({ top: 4 })
            }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
            .padding(14)
            .margin({ bottom: 8 })
            .backgroundColor(Tokens.surface)
            .borderRadius(Tokens.settingsRadius)
          }, (row: CollectionItem) => row.id)
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 32 })
      }
      .layoutWeight(1)
      .align(Alignment.Top)
      .scrollBar(BarState.Off)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}
