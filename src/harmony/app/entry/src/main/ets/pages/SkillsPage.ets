import { common } from '@kit.AbilityKit';
import { LocalSkill, skillStore } from '../store/SkillStore';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct SkillsPage {
  @State name: string = '';
  @State body: string = '';
  @State rows: LocalSkill[] = [];
  @State message: string = '';

  aboutToAppear(): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    skillStore.load(ctx).then(() => {
      this.rows = skillStore.skills.slice();
    });
  }

  build() {
    Column() {
      Text('技能')
        .fontSize(Tokens.title)
        .fontWeight(FontWeight.Bold)
        .fontColor(Tokens.text)
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 12, bottom: 12 })
      Scroll() {
        Column() {
          TextInput({ text: this.name, placeholder: '技能名' })
            .onChange((value: string) => {
              this.name = value;
            })
            .height(44)
            .backgroundColor(Tokens.surface)
            .fontColor(Tokens.text)
            .borderRadius(Tokens.settingsRadius)
          TextArea({ text: this.body, placeholder: 'SKILL.md 正文' })
            .onChange((value: string) => {
              this.body = value;
            })
            .height(120)
            .margin({ top: 8 })
            .backgroundColor(Tokens.surface)
            .fontColor(Tokens.text)
            .borderRadius(Tokens.settingsRadius)
          Button('保存技能')
            .width('100%')
            .height(44)
            .margin({ top: 12, bottom: 16 })
            .backgroundColor(Tokens.accent)
            .fontColor('#FFFFFF')
            .onClick(() => {
              const ctx = getContext(this) as common.UIAbilityContext;
              skillStore.upsert(ctx, this.name, this.body).then(() => {
                this.rows = skillStore.skills.slice();
                this.message = '已保存';
              }).catch((err: Error) => {
                this.message = `${err}`;
              });
            })
          ForEach(this.rows, (row: LocalSkill) => {
            Row() {
              Column() {
                Text(row.name)
                  .fontSize(Tokens.rowTitle)
                  .fontColor(Tokens.text)
                Text(row.enabled ? '已启用，会注入本机对话' : '已关闭')
                  .fontSize(12)
                  .fontColor(Tokens.muted)
                  .margin({ top: 2 })
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)
              Text(row.enabled ? '关闭' : '启用')
                .fontSize(13)
                .fontColor(Tokens.accent)
                .onClick(() => {
                  const ctx = getContext(this) as common.UIAbilityContext;
                  skillStore.toggle(ctx, row.id).then(() => {
                    this.rows = skillStore.skills.slice();
                  });
                })
            }
            .width('100%')
            .padding({ left: 14, right: 14, top: 12, bottom: 12 })
            .margin({ bottom: 8 })
            .backgroundColor(Tokens.surface)
            .borderRadius(Tokens.settingsRadius)
          }, (row: LocalSkill) => row.id)
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
}
