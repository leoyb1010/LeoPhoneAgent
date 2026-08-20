import { common } from '@kit.AbilityKit';
import { ModelGroup, ProviderInstance, providerStore } from '../store/ProviderStore';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct ModelGroupsPage {
  @StorageProp('themeTick') tick: number = 0;
  @State name: string = '';
  @State picked: string[] = [];
  @State groups: ModelGroup[] = [];
  @State models: string[] = [];
  @State message: string = '';

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    providerStore.ensureLoaded(ctx).then(() => {
      this.groups = providerStore.groups.slice();
      this.models = this.collect();
    });
  }

  build() {
    Column() {
      Text('模型组')
        .fontSize(Tokens.title)
        .fontWeight(FontWeight.Bold)
        .fontColor(Tokens.text)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 12, bottom: 8 })
      Text('新任务可以绑一组模型，失败时按顺序换下一个。')
        .fontSize(13)
        .fontColor(Tokens.muted)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 12 })
      Scroll() {
        Column() {
          TextInput({ text: this.name, placeholder: '组名，例如 日常' })
            .onChange((value: string) => {
              this.name = value;
            })
            .height(44)
            .backgroundColor(Tokens.surface)
            .fontColor(Tokens.text)
            .borderRadius(Tokens.settingsRadius)
          ForEach(this.models, (id: string) => {
            Row() {
              Text(id)
                .fontSize(14)
                .fontColor(Tokens.text)
                .layoutWeight(1)
              Text(this.picked.indexOf(id) >= 0 ? '已选' : '加入')
                .fontSize(13)
                .fontColor(Tokens.link)
            }
            .width('100%')
            .padding({ top: 10, bottom: 10 })
            .onClick(() => {
              this.toggle(id);
            })
          }, (id: string) => id)
          Button('保存模型组')
            .width('100%')
            .height(44)
            .margin({ top: 8, bottom: 16 })
            .backgroundColor(Tokens.accent)
            .fontColor('#FFFFFF')
            .onClick(() => {
              this.save();
            })
          ForEach(this.groups, (row: ModelGroup) => {
            Row() {
              Column() {
                Text(row.name)
                  .fontSize(Tokens.rowTitle)
                  .fontColor(Tokens.text)
                Text(row.modelIds.join(' → '))
                  .fontSize(12)
                  .fontColor(Tokens.muted)
                  .margin({ top: 2 })
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)
              Text(providerStore.activeGroupId === row.id ? '默认' : '用作默认')
                .fontSize(13)
                .fontColor(Tokens.link)
                .margin({ right: 10 })
                .onClick(() => {
                  this.makeDefault(row.id);
                })
              Text('删除')
                .fontSize(13)
                .fontColor(Tokens.accent)
                .onClick(() => {
                  this.remove(row.id);
                })
            }
            .width('100%')
            .padding(14)
            .margin({ bottom: 8 })
            .backgroundColor(Tokens.surface)
            .borderRadius(Tokens.settingsRadius)
          }, (row: ModelGroup) => row.id)
          if (this.message.length > 0) {
            Text(this.message)
              .fontColor(Tokens.online)
          }
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

  private collect(): string[] {
    const out: string[] = [];
    for (let i = 0; i < providerStore.instances.length; i++) {
      const row: ProviderInstance = providerStore.instances[i];
      const id = `${row.label || row.type}/${row.model}`;
      if (out.indexOf(id) < 0) {
        out.push(id);
      }
    }
    return out;
  }

  private toggle(id: string): void {
    if (this.picked.indexOf(id) >= 0) {
      this.picked = this.picked.filter((row: string) => row !== id);
    } else {
      this.picked = this.picked.concat([id]);
    }
  }

  private async save(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      await providerStore.addGroup(ctx, this.name, this.picked.slice());
      this.groups = providerStore.groups.slice();
      this.name = '';
      this.picked = [];
      this.message = '已保存';
    } catch (err) {
      this.message = `${err}`;
    }
  }

  private async makeDefault(id: string): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    await providerStore.setActiveGroup(ctx, id);
    this.message = '已设为默认，失败会按顺序换';
  }

  private async remove(id: string): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    await providerStore.removeGroup(ctx, id);
    this.groups = providerStore.groups.slice();
  }
}
