import { Sym } from '../theme/Symbols';
import { Tokens } from '../theme/Tokens';

/**
 * 输入框:一张圆角卡片(和 iOS、安卓一样)。上面一排是模型和审批方式,中间是会长高的输入区,
 * 下面一排是 +(照片、文件)、/(命令)、话筒、发送;在跑时发送按钮变成红色停止。
 */
@Component
export struct Composer {
  @Link draft: string;
  @Prop placeholder: string = '给 LeoPhoneAgent 交代任务';
  @Prop running: boolean = false;
  @Prop ready: boolean = true;
  /** 空字符串就不显示模型芯片。 */
  @Prop modelLabel: string = '';
  @Prop showApproval: boolean = true;
  @Prop fullAuto: boolean = false;
  @Prop files: string[] = [];
  @Prop imagePath: string = '';
  @Prop listening: boolean = false;
  @Prop returnSend: boolean = false;
  @Prop tools: boolean = true;
  @Prop showMic: boolean = true;
  onSend: () => void = () => {
  };
  onStop: () => void = () => {
  };
  onPickImage: () => void = () => {
  };
  onPickFiles: () => void = () => {
  };
  onSlash: () => void = () => {
  };
  onMic: () => void = () => {
  };
  onModel: () => void = () => {
  };
  onApproval: () => void = () => {
  };
  onRemoveFile: (index: number) => void = (_index: number) => {
  };
  onRemoveImage: () => void = () => {
  };

  build() {
    Column() {
      if (this.modelLabel.length > 0 || this.showApproval) {
        Row() {
          if (this.modelLabel.length > 0) {
            Row() {
              Sym({ name: 'memory_module', dim: 13, color: Tokens.secondary })
              Text(this.modelLabel)
                .fontSize(12.5)
                .fontColor(Tokens.secondary)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .constraintSize({ maxWidth: 180 })
                .margin({ left: 4 })
              Sym({ name: 'chevron_down', dim: 9, color: Tokens.muted })
                .margin({ left: 3 })
            }
            .height(26)
            .padding({ left: 9, right: 9 })
            .backgroundColor(Tokens.chip)
            .borderRadius(13)
            .onClick(() => {
              this.onModel();
            })
          }
          if (this.showApproval) {
            Row() {
              Sym({
                name: this.fullAuto ? 'bolt_fill' : 'hand',
                dim: 12,
                color: this.fullAuto ? Tokens.warn : Tokens.secondary
              })
              Text(this.fullAuto ? '全自动' : '逐项确认')
                .fontSize(12.5)
                .fontColor(this.fullAuto ? Tokens.warn : Tokens.secondary)
                .margin({ left: 4 })
            }
            .height(26)
            .padding({ left: 9, right: 9 })
            .backgroundColor(this.fullAuto ? Tokens.warnTint : Tokens.chip)
            .borderRadius(13)
            .margin({ left: this.modelLabel.length > 0 ? 6 : 0 })
            .onClick(() => {
              this.onApproval();
            })
          }
        }
        .width('100%')
        .padding({ left: 10, right: 10, top: 10 })
      }
      if (this.imagePath.length > 0 || this.files.length > 0) {
        Scroll() {
          Row() {
            if (this.imagePath.length > 0) {
              Stack({ alignContent: Alignment.TopEnd }) {
                Image(this.imagePath)
                  .width(56)
                  .height(56)
                  .objectFit(ImageFit.Cover)
                  .borderRadius(10)
                this.removeDot(() => {
                  this.onRemoveImage();
                })
              }
              .margin({ right: 8 })
            }
            ForEach(this.files, (name: string, index: number) => {
              Stack({ alignContent: Alignment.TopEnd }) {
                Row() {
                  Sym({ name: 'doc', dim: 16, color: Tokens.secondary })
                  Text(name)
                    .fontSize(12.5)
                    .fontColor(Tokens.text)
                    .maxLines(2)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                    .constraintSize({ maxWidth: 120 })
                    .margin({ left: 6 })
                }
                .height(56)
                .padding({ left: 10, right: 14 })
                .backgroundColor(Tokens.chip)
                .borderRadius(10)
                this.removeDot(() => {
                  this.onRemoveFile(index);
                })
              }
              .margin({ right: 8 })
            }, (name: string, index: number) => `${index}:${name}`)
          }
          .padding({ top: 6 })
        }
        .scrollable(ScrollDirection.Horizontal)
        .scrollBar(BarState.Off)
        .align(Alignment.Start)
        .width('100%')
        .padding({ left: 10, right: 10, top: 6 })
      }
      TextArea({ text: this.draft, placeholder: this.placeholder })
        .fontSize(16.5)
        .fontColor(Tokens.text)
        .placeholderColor(Tokens.muted)
        .placeholderFont({ size: 16.5 })
        .backgroundColor('#00000000')
        .constraintSize({ minHeight: 44, maxHeight: 132 })
        .padding({ left: 12, right: 12, top: 10, bottom: 4 })
        .enterKeyType(this.returnSend ? EnterKeyType.Send : EnterKeyType.NEW_LINE)
        .onSubmit(() => {
          if (this.returnSend) {
            this.onSend();
          }
        })
        .onChange((value: string) => {
          this.draft = value;
        })
      Row() {
        if (this.tools) {
          Stack() {
            Sym({ name: 'plus', dim: 17, color: Tokens.text })
          }
          .width(Tokens.sendSize)
          .height(Tokens.sendSize)
          .backgroundColor(Tokens.chip)
          .borderRadius(Tokens.sendSize / 2)
          .bindMenu([
              {
                value: '选择照片',
                action: () => {
                  this.onPickImage();
                }
              },
              {
                value: '添加文件',
                action: () => {
                  this.onPickFiles();
                }
              }
            ])
          Text('/')
            .fontSize(17)
            .fontWeight(FontWeight.Medium)
            .fontStyle(FontStyle.Italic)
            .fontColor(Tokens.text)
            .width(Tokens.sendSize)
            .height(Tokens.sendSize)
            .textAlign(TextAlign.Center)
            .backgroundColor(Tokens.chip)
            .borderRadius(Tokens.sendSize / 2)
            .margin({ left: 8 })
            .onClick(() => {
              this.onSlash();
            })
        }
        Blank()
        if (this.showMic && (!this.running || this.draft.trim().length > 0)) {
          Stack() {
            Sym({ name: this.listening ? 'mic_fill' : 'mic', dim: 17, color: this.listening ? Tokens.accent : Tokens.text })
          }
          .width(Tokens.sendSize)
          .height(Tokens.sendSize)
          .backgroundColor(this.listening ? Tokens.accentSoft : Tokens.chip)
          .borderRadius(Tokens.sendSize / 2)
          .margin({ right: 8 })
          .onClick(() => {
            this.onMic();
          })
        }
        if (this.running && this.draft.trim().length === 0 && this.files.length === 0 && this.imagePath.length === 0) {
          Stack() {
            Column()
              .width(Tokens.sendSize)
              .height(Tokens.sendSize)
              .borderRadius(Tokens.sendSize / 2)
              .backgroundColor(Tokens.danger)
            Column()
              .width(11)
              .height(11)
              .borderRadius(2.5)
              .backgroundColor('#FFFFFF')
          }
          .width(Tokens.sendSize)
          .height(Tokens.sendSize)
          .onClick(() => {
            this.onStop();
          })
        } else {
          this.circle('arrow_up', this.canSend() ? Tokens.send : Tokens.sendOff, Tokens.sendGlyph, () => {
            if (this.canSend()) {
              this.onSend();
            }
          })
        }
      }
      .width('100%')
      .padding({ left: 10, right: 10, bottom: 10, top: 2 })
    }
    .width('100%')
    .backgroundColor(Tokens.composer)
    .borderRadius(Tokens.composerRadius)
    .border({ width: Tokens.dark ? Tokens.hairline : 0, color: Tokens.separator })
    .shadow({ radius: 16, color: Tokens.composerShadow, offsetY: 2 })
  }

  @Builder
  circle(name: string, fill: string, color: string, tap: () => void) {
    Stack() {
      Sym({ name: name, dim: 17, color: color })
    }
    .width(Tokens.sendSize)
    .height(Tokens.sendSize)
    .backgroundColor(fill)
    .borderRadius(Tokens.sendSize / 2)
    .onClick(() => {
      tap();
    })
  }

  @Builder
  removeDot(tap: () => void) {
    Stack() {
      Sym({ name: 'xmark', dim: 9, color: '#FFFFFF' })
    }
    .width(18)
    .height(18)
    .backgroundColor('#99000000')
    .borderRadius(9)
    .margin({ top: -4, right: -4 })
    .onClick(() => {
      tap();
    })
  }

  private canSend(): boolean {
    return this.ready && (this.draft.trim().length > 0 || this.files.length > 0 || this.imagePath.length > 0);
  }
}
