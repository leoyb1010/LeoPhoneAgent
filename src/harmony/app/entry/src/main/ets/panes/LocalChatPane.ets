import { common } from '@kit.AbilityKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { router } from '@kit.ArkUI';
import { ChatItem, chatItemKey, chatItems } from '../local/AgentText';
import { ChatRun, ChatRuns, PendingImage, textLines } from '../local/ChatRun';
import { Voice } from '../local/Voice';
import { LocalChatMessage, nextThinking, thinkingLabel } from '../local/LocalProtocol';
import { LocalTools } from '../local/LocalTools';
import { SensitiveToolGate } from '../local/SensitiveToolGate';
import { ProviderInstance, providerStore } from '../store/ProviderStore';
import { themeStore } from '../store/ThemeStore';
import { sessionStore } from '../store/SessionStore';
import { soulStore } from '../store/SoulStore';
import { Attachments } from '../chat/Attachments';
import { Composer } from '../chat/Composer';
import {
  AssistantHead,
  ErrorRow,
  NoticeRow,
  ReplyActions,
  SummaryRow,
  ToolCapsule,
  TypingRow,
  UserBubble,
  WorkedRow
} from '../chat/ChatViews';
import { MarkdownText } from '../theme/Markdown';
import { Copy } from '../theme/Copy';
import { Sym } from '../theme/Symbols';
import { StatusPill } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

/** 首页输入框发出的第一句:对话页一打开就发出去。 */
export class FirstMessage {
  sessionId: string = '';
  text: string = '';
  files: string[] = [];
  image: PendingImage | null = null;
}

export class LocalChatLaunch {
  static sessionId: string = '';
  static first: FirstMessage | null = null;
}

class SlashCommand {
  name: string = '';
  desc: string = '';
  /** 选中就直接执行(不用再填参数)。 */
  now: boolean = false;
}

function slash(name: string, desc: string, now: boolean): SlashCommand {
  const cmd = new SlashCommand();
  cmd.name = name;
  cmd.desc = desc;
  cmd.now = now;
  return cmd;
}

const SLASH_COMMANDS: SlashCommand[] = [
  slash('/compact', '把前面的对话压成摘要', true),
  slash('/auto', '切换全自动 / 逐项确认', true),
  slash('/ls', '看沙箱里的文件', true),
  slash('/read', '读一个沙箱文件', false),
  slash('/write', '写一个沙箱文件', false),
  slash('/remember', '记到今日记忆', false),
  slash('/open', '在应用内打开链接', false)
];

/**
 * 本机对话页。画法对齐 iOS / 安卓:回答不套气泡、上面一行「✦ LeoPhoneAgent」;你说的话是右边的灰气泡;
 * 工具是一个个胶囊,说完的一轮折成「已工作 N 步」;输入框是一张卡片,里面有模型和审批方式。
 * 一轮跑在 ChatRun 里,这里只负责看和转交操作(离开页面照样跑)。
 */
@Component
export struct LocalChatPane {
  @StorageProp('themeTick') tick: number = 0;
  @StorageProp('providerTick') @Watch('onProviderTick') providerTick: number = 0;
  @StorageProp('chatTick') @Watch('onChatTick') chatTick: number = 0;
  @Prop @Watch('onSessionChange') sessionId: string = '';
  @StorageProp('approvalTick') @Watch('onApprovalTick') approvalTick: number = 0;
  @Prop compact: boolean = false;
  @State lines: LocalChatMessage[] = [];
  @State items: ChatItem[] = [];
  /** 正在流式输出的那段回答的字(见 chatItemKey)。 */
  @State liveText: string = '';
  @State fullAuto: boolean = false;
  @State title: string = 'LeoPhoneAgent';
  @State draft: string = '';
  @State status: string = '准备中';
  @State configured: boolean = false;
  @State ready: boolean = false;
  @State thinking: string = '';
  @State askWrite: boolean = false;
  @State askTitle: string = '';
  /** 有一轮在跑:发送按钮变成停止。 */
  @State active: boolean = false;
  /** 上一轮没做完:显示「继续」。 */
  @State interrupted: boolean = false;
  @State listening: boolean = false;
  @State modelLine: string = '';
  @State modelSheet: boolean = false;
  @State pickerRows: ProviderInstance[] = [];
  @State pickerOpenId: string = '';
  @State slashOpen: boolean = false;
  @State openTurns: number[] = [];
  @State pendingFiles: string[] = [];
  @State pendingImagePath: string = '';
  @State showDown: boolean = false;
  @State unseen: boolean = false;
  private image: PendingImage | null = null;
  private chatScroller: Scroller = new Scroller();
  private alive: boolean = false;
  private currentId: string = '';
  /** 这个页面在看的对话。一轮跑在它里面,离开页面、切走都不作废(见 ChatRun)。 */
  private run: ChatRun | null = null;
  /** 上次抄到页面上的 run.lines(比对「是不是只有最后一段多了几个字」用)。 */
  private shown: LocalChatMessage[] = [];
  private stopListen: (() => void) | null = null;
  private nearBottom: boolean = true;

  aboutToAppear(): void {
    this.boot();
  }

  onProviderTick(): void {
    if (this.alive) {
      this.configured = providerStore.configured();
      this.refreshSlot();
      if (this.status === '未配置 AI 服务商' && this.configured) {
        this.status = '空闲';
      }
    }
  }

  onApprovalTick(): void {
    this.fullAuto = SensitiveToolGate.fullAuto;
  }

  onChatTick(): void {
    this.sync();
  }

  aboutToDisappear(): void {
    // 离开页面不再作废正在跑的一轮:它接着跑,说完了 App 在后台就发通知。
    this.alive = false;
    this.detach();
    if (this.stopListen) {
      this.stopListen();
      this.stopListen = null;
      this.listening = false;
    }
  }

  onSessionChange(): void {
    // 切对话:原来那个对话的这一轮接着跑,这里换成看新的。
    this.detach();
    this.lines = [];
    this.items = [];
    this.liveText = '';
    this.shown = [];
    this.draft = '';
    this.image = null;
    this.pendingFiles = [];
    this.pendingImagePath = '';
    this.openTurns = [];
    this.slashOpen = false;
    this.active = false;
    this.interrupted = false;
    this.askWrite = false;
    this.boot();
  }

  build() {
    Column() {
      this.header()
      Stack({ alignContent: Alignment.Bottom }) {
        if (this.lines.length === 0) {
          if (!this.configured && this.ready) {
            this.centerCopy('先配一个 AI 服务商', '设置 → AI 服务商，先选类型再填钥匙。不连中继也能聊。')
          } else {
            this.emptyWorkspace()
          }
        } else {
          List({ scroller: this.chatScroller }) {
            ForEach(this.items, (item: ChatItem, i: number) => {
              ListItem() {
                this.itemView(item)
              }
              .width('100%')
            }, (item: ChatItem, i: number) => chatItemKey(item, i))
          }
          .width('100%')
          .height('100%')
          .padding({ left: Tokens.pagePad, right: Tokens.pagePad })
          .contentStartOffset(8)
          .contentEndOffset(16)
          .alignListItem(ListItemAlign.Center)
          .scrollBar(BarState.Off)
          .edgeEffect(EdgeEffect.Spring)
          .onScrollIndex((start: number, end: number) => {
            // 往上翻着看旧消息时,流式输出不再把你拽回底部。
            this.nearBottom = end >= this.items.length - 2;
            this.showDown = !this.nearBottom;
            if (this.nearBottom) {
              this.unseen = false;
            }
          })
        }
        if (this.showDown && this.items.length > 0) {
          this.downButton()
        }
      }
      .layoutWeight(1)
      .width('100%')

      if (this.currentId.length > 0 || this.configured) {
        Column() {
          if (this.askWrite) {
            this.approvalCard()
          } else if (this.interrupted && !this.active && !this.lastIsError()) {
            this.resumeCard()
          }
          if (this.slashOpen) {
            this.slashPanel()
          }
          Composer({
            draft: $draft,
            placeholder: '给 LeoPhoneAgent 交代任务',
            running: this.active,
            ready: this.ready,
            modelLabel: this.modelLine,
            showApproval: true,
            fullAuto: this.fullAuto,
            files: this.pendingFiles,
            imagePath: this.pendingImagePath,
            listening: this.listening,
            returnSend: themeStore.returnSend,
            onSend: () => {
              this.send();
            },
            onStop: () => {
              if (this.run) {
                this.run.stop();
              }
            },
            onPickImage: () => {
              this.pickImage();
            },
            onPickFiles: () => {
              this.pickFiles();
            },
            onSlash: () => {
              this.slashOpen = !this.slashOpen;
            },
            onMic: () => {
              this.toggleListen();
            },
            onModel: () => {
              this.openModelSheet();
            },
            onApproval: () => {
              this.toggleFullAuto();
            },
            onRemoveFile: (index: number) => {
              this.pendingFiles = this.pendingFiles.filter((_name: string, i: number) => i !== index);
            },
            onRemoveImage: () => {
              this.image = null;
              this.pendingImagePath = '';
            }
          })
        }
        .width('100%')
        .constraintSize({ maxWidth: Tokens.readable + 24 })
        .padding({ left: 10, right: 10, top: 4, bottom: 10 })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
    .bindSheet($$this.modelSheet, this.modelSheetView(), {
      height: SheetSize.MEDIUM,
      dragBar: true,
      title: { title: '选模型' }
    })
  }

  @Builder
  header() {
    Stack() {
      Column() {
        Text(themeStore.showTitle ? this.title : 'LeoPhoneAgent')
          .fontSize(16)
          .fontWeight(FontWeight.Medium)
          .fontColor(Tokens.text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Row() {
          Column()
            .width(6)
            .height(6)
            .borderRadius(3)
            .backgroundColor(this.badStatus() || !this.configured || this.askWrite ? Tokens.warn : Tokens.online)
          Text(this.subtitle())
            .fontSize(12)
            .fontColor(this.badStatus() ? Tokens.warn : Tokens.secondary)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .margin({ left: 5 })
          if (this.configured) {
            Sym({ name: 'chevron_down', dim: 9, color: Tokens.muted })
              .margin({ left: 3 })
          }
        }
        .margin({ top: 2 })
        .onClick(() => {
          this.openModelSheet();
        })
      }
      .padding({ left: 104, right: 104 })
      Row() {
        if (!this.compact) {
          Stack() {
            Sym({ name: 'chevron_left', dim: 20, color: Tokens.text })
          }
          .width(40)
          .height(40)
          .onClick(() => {
            router.back();
          })
        }
        Blank()
        Row() {
          Sym({ name: 'lightbulb', dim: 13, color: this.thinking.length > 0 ? Tokens.accent : Tokens.muted })
          Text(thinkingLabel(this.thinking))
            .fontSize(12)
            .fontColor(this.thinking.length > 0 ? Tokens.accent : Tokens.muted)
            .margin({ left: 2 })
        }
        .height(28)
        .padding({ left: 8, right: 9 })
        .backgroundColor(this.thinking.length > 0 ? Tokens.accentSoft : Tokens.surface)
        .borderRadius(14)
        .onClick(() => {
          this.thinking = nextThinking(this.thinking);
        })
        Stack() {
          Sym({ name: 'ellipsis_circle', dim: 22, color: Tokens.text })
        }
        .width(40)
        .height(40)
        .margin({ left: 2 })
        .bindMenu([
          {
            value: '新对话',
            action: () => {
              this.newSession();
            }
          },
          {
            value: '压缩前面的对话',
            action: () => {
              this.runCommand('/compact');
            }
          },
          {
            value: '导出这个对话',
            action: () => {
              this.exportSession();
            }
          },
          {
            value: '朗读最后的回答',
            action: () => {
              this.readLast();
            }
          }
        ])
      }
      .width('100%')
    }
    .width('100%')
    .height(Tokens.chatBar)
    .padding({ left: 6, right: 8 })
    .border({ width: { bottom: Tokens.hairline }, color: Tokens.separator })
  }

  @Builder
  itemView(item: ChatItem) {
    Column() {
      if (item.head) {
        AssistantHead({ name: this.agentName() })
          .margin({ top: 10 })
      }
      if (item.kind === 'user') {
        Row() {
          Blank()
          UserBubble({
            text: item.text,
            imagePath: this.lineImage(item.index),
            files: this.lineFiles(item.index)
          })
        }
        .width('100%')
        .margin({ top: 12, bottom: 4 })
      } else if (item.kind === 'assistant') {
        MarkdownText({ text: item.live ? this.liveText : item.text })
        if (item.partial) {
          Text('没说完')
            .fontSize(12)
            .fontColor(Tokens.muted)
            .margin({ top: 2 })
        }
        if (item.last) {
          ReplyActions({
            regenerate: this.isLatest(item),
            onCopy: () => {
              this.copyText(item.text);
            },
            onSpeak: () => {
              this.speak(item.text);
            },
            onRegenerate: () => {
              this.regenerate();
            }
          })
        }
      } else if (item.kind === 'tool') {
        ToolCapsule({ item: item })
      } else if (item.kind === 'worked') {
        WorkedRow({
          item: item,
          onToggle: () => {
            this.toggleTurn(item.turn);
          }
        })
      } else if (item.kind === 'notice') {
        NoticeRow({ text: item.text })
      } else if (item.kind === 'error') {
        ErrorRow({
          text: item.text,
          action: this.errorAction(item),
          onAction: () => {
            if (this.run) {
              this.run.resume(this.thinking);
            }
          }
        })
      } else if (item.kind === 'summary') {
        SummaryRow({ item: item })
      } else if (item.kind === 'typing') {
        TypingRow()
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .constraintSize({ maxWidth: Tokens.readable })
  }

  @Builder
  downButton() {
    if (this.unseen) {
      Row() {
        Sym({ name: 'arrow_down', dim: 13, color: Tokens.text })
        Text('新消息')
          .fontSize(13)
          .fontColor(Tokens.text)
          .margin({ left: 4 })
      }
      .height(32)
      .padding({ left: 12, right: 12 })
      .backgroundColor(Tokens.card)
      .borderRadius(16)
      .shadow({ radius: 10, color: '#26000000', offsetY: 2 })
      .margin({ bottom: 12 })
      .onClick(() => {
        this.followTail(true);
      })
    } else {
      Row() {
        Blank()
        Stack() {
          Sym({ name: 'arrow_down', dim: 16, color: Tokens.text })
        }
        .width(36)
        .height(36)
        .backgroundColor(Tokens.card)
        .borderRadius(18)
        .border({ width: Tokens.hairline, color: Tokens.separator })
        .shadow({ radius: 8, color: '#1F000000', offsetY: 2 })
        .onClick(() => {
          this.followTail(true);
        })
      }
      .width('100%')
      .padding({ right: 16, bottom: 12 })
    }
  }

  @Builder
  approvalCard() {
    Column() {
      Row() {
        Sym({ name: 'hand', dim: 15, color: Tokens.warn })
        Text(this.askTitle)
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .fontColor(Tokens.text)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ left: 6 })
          .layoutWeight(1)
      }
      .width('100%')
      Row() {
        this.cardButton('允许一次', true, () => {
          this.allowWrite(false);
        })
        this.cardButton('本次会话允许', false, () => {
          this.allowWrite(true);
        })
        this.cardButton('拒绝', false, () => {
          this.denyWrite(false);
        })
      }
      .width('100%')
      .margin({ top: 10 })
      Text('拒绝并停止任务')
        .fontSize(13)
        .fontColor(Tokens.danger)
        .margin({ top: 10 })
        .onClick(() => {
          this.denyWrite(true);
        })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .padding(14)
    .backgroundColor(Tokens.card)
    .borderRadius(16)
    .border({ width: Tokens.hairline, color: Tokens.separator })
    .shadow({ radius: 12, color: Tokens.composerShadow, offsetY: 2 })
    .margin({ bottom: 8 })
  }

  @Builder
  cardButton(label: string, primary: boolean, tap: () => void) {
    Text(label)
      .fontSize(14)
      .fontWeight(FontWeight.Medium)
      .fontColor(primary ? '#FFFFFF' : Tokens.text)
      .textAlign(TextAlign.Center)
      .height(36)
      .layoutWeight(1)
      .backgroundColor(primary ? Tokens.accent : Tokens.chip)
      .borderRadius(18)
      .margin({ right: 8 })
      .onClick(() => {
        tap();
      })
  }

  @Builder
  resumeCard() {
    Row() {
      Sym({ name: 'exclamationmark_triangle', dim: 14, color: Tokens.warn })
      Text('已中断 - 点击「继续」以恢复')
        .fontSize(13)
        .fontColor(Tokens.text)
        .layoutWeight(1)
        .margin({ left: 8 })
      Text('继续')
        .fontSize(13)
        .fontWeight(FontWeight.Medium)
        .fontColor('#FFFFFF')
        .padding({ left: 14, right: 14, top: 6, bottom: 6 })
        .backgroundColor(Tokens.warn)
        .borderRadius(14)
        .onClick(() => {
          if (this.run) {
            this.run.resume(this.thinking);
          }
        })
    }
    .width('100%')
    .padding({ left: 12, right: 10, top: 8, bottom: 8 })
    .backgroundColor(Tokens.warnTint)
    .borderRadius(12)
    .margin({ bottom: 8 })
  }

  @Builder
  slashPanel() {
    Column() {
      ForEach(SLASH_COMMANDS, (cmd: SlashCommand) => {
        Row() {
          Text(cmd.name)
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor(Tokens.text)
            .width(92)
          Text(cmd.desc)
            .fontSize(13)
            .fontColor(Tokens.secondary)
            .layoutWeight(1)
            .maxLines(1)
        }
        .width('100%')
        .height(44)
        .padding({ left: 14, right: 14 })
        .onClick(() => {
          this.pickSlash(cmd);
        })
      }, (cmd: SlashCommand) => cmd.name)
    }
    .width('100%')
    .backgroundColor(Tokens.card)
    .borderRadius(12)
    .border({ width: Tokens.hairline, color: Tokens.separator })
    .shadow({ radius: 12, color: Tokens.composerShadow, offsetY: 2 })
    .margin({ bottom: 8 })
  }

  @Builder
  modelSheetView() {
    Scroll() {
      Column() {
        ForEach(this.pickerRows, (row: ProviderInstance) => {
          Column() {
            Row() {
              Text(row.label.length > 0 ? row.label : row.type)
                .fontSize(15)
                .fontWeight(FontWeight.Medium)
                .fontColor(Tokens.text)
                .layoutWeight(1)
              if (providerStore.activeId === row.id) {
                Text('当前')
                  .fontSize(12)
                  .fontColor(Tokens.accent)
              }
              Sym({ name: this.pickerOpenId === row.id ? 'chevron_up' : 'chevron_down', dim: 11, color: Tokens.muted })
                .margin({ left: 6 })
            }
            .width('100%')
            .height(48)
            .onClick(() => {
              this.pickerOpenId = this.pickerOpenId === row.id ? '' : row.id;
            })
            if (this.pickerOpenId === row.id) {
              ForEach(this.slotModels(row), (id: string) => {
                Row() {
                  Text(id)
                    .fontSize(14)
                    .fontColor(Tokens.text)
                    .layoutWeight(1)
                    .maxLines(1)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                  if (providerStore.activeId === row.id && row.model === id) {
                    Sym({ name: 'checkmark', dim: 14, color: Tokens.accent })
                  }
                }
                .width('100%')
                .height(42)
                .padding({ left: 12 })
                .onClick(() => {
                  this.useSlot(row.id, id);
                })
              }, (id: string) => `${row.id}/${id}`)
            }
            Divider()
              .strokeWidth(Tokens.hairline)
              .color(Tokens.separator)
          }
          .width('100%')
        }, (row: ProviderInstance) => row.id)
      }
      .width('100%')
      .padding({ left: 20, right: 20, bottom: 24 })
    }
    .scrollBar(BarState.Off)
    .align(Alignment.Top)
  }

  @Builder
  emptyWorkspace() {
    Scroll() {
      Column() {
        Stack() {
          Column()
            .width(this.compact ? Tokens.heroCompact : Tokens.hero)
            .height(this.compact ? Tokens.heroCompact : Tokens.hero)
            .borderRadius(this.compact ? 16 : Tokens.heroRadius)
            .linearGradient({
              angle: 135,
              colors: [[Tokens.heroA, 0], [Tokens.heroB, 1]]
            })
          Sym({ name: 'wand_and_stars_fill', dim: this.compact ? 24 : 32, color: '#FFFFFF' })
        }
        .width(this.compact ? Tokens.heroCompact : Tokens.hero)
        .height(this.compact ? Tokens.heroCompact : Tokens.hero)
        .margin({ bottom: 16 })
        Text(Copy.readyTitle)
          .fontSize(this.compact ? 21 : 24)
          .fontWeight(FontWeight.Bold)
          .fontColor(Tokens.text)
        Text(Copy.readySubtitle)
          .fontSize(14)
          .lineHeight(20)
          .fontColor(Tokens.secondary)
          .textAlign(TextAlign.Center)
          .margin({ top: 8, bottom: 14 })
        Row() {
          StatusPill({ label: Copy.localBadge, dot: Tokens.online })
          StatusPill({ label: Copy.privateBadge, dot: Tokens.heroB })
            .margin({ left: 8 })
        }
        .margin({ bottom: 22 })
        this.quickTask(Copy.taskPhone, Copy.promptPhone, 'hand_point_up_tap', Tokens.heroA)
        this.quickTask(Copy.taskResearch, Copy.promptResearch, 'magnifyingglass', Tokens.heroB)
        this.quickTask(Copy.taskAutomate, Copy.promptAutomate, 'clock', Tokens.warn)
      }
      .width('100%')
      .constraintSize({ maxWidth: 520 })
      .alignItems(HorizontalAlign.Center)
      .padding({ left: 24, right: 24, top: this.compact ? 20 : 40, bottom: 16 })
    }
    .width('100%')
    .height('100%')
    .align(Alignment.Top)
    .scrollBar(BarState.Off)
  }

  @Builder
  quickTask(title: string, prompt: string, icon: string, color: string) {
    Row() {
      Stack() {
        Sym({ name: icon, dim: 16, color: color })
      }
      .width(32)
      .height(32)
      .backgroundColor(`#29${color.substring(1)}`)
      .borderRadius(10)
      Text(title)
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(Tokens.text)
        .margin({ left: Tokens.rowGap })
        .layoutWeight(1)
      Sym({ name: 'chevron_right', dim: 13, color: Tokens.muted })
    }
    .width('100%')
    .height(54)
    .padding({ left: 12, right: 14 })
    .margin({ bottom: 8 })
    .backgroundColor(Tokens.surface)
    .borderRadius(Tokens.cardRadius)
    .onClick(() => {
      this.draft = prompt;
    })
  }

  @Builder
  centerCopy(title: string, body: string) {
    Column() {
      Text(title)
        .fontSize(20)
        .fontWeight(FontWeight.Medium)
        .fontColor(Tokens.text)
      Text(body)
        .fontSize(14)
        .fontColor(Tokens.secondary)
        .margin({ top: 8 })
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .padding(24)
  }

  private refreshSlot(): void {
    const row = providerStore.active();
    this.modelLine = row ? (row.model.length > 0 ? row.model : `${row.label} · 还没选模型`) : '';
  }

  private openModelSheet(): void {
    if (providerStore.instances.length === 0) {
      return;
    }
    this.pickerRows = providerStore.instances.slice();
    this.pickerOpenId = providerStore.activeId;
    this.modelSheet = true;
  }

  private slotModels(row: ProviderInstance): string[] {
    if (row.models.length > 0) {
      return row.models;
    }
    return row.model.length > 0 ? [row.model] : [];
  }

  private useSlot(id: string, model: string): void {
    const ctx = getContext(this) as common.UIAbilityContext;
    providerStore.setActiveModel(ctx, id, model).then(() => {
      this.configured = providerStore.configured();
      this.refreshSlot();
      this.modelSheet = false;
      this.status = this.configured ? '空闲' : '未配置 AI 服务商';
    }).catch((err: Error) => {
      this.status = `${err}`;
    });
  }

  private badStatus(): boolean {
    return this.status.indexOf('失败') >= 0 || this.status.indexOf('AI 服务商') >= 0 ||
      this.status.indexOf('断了') >= 0 || this.status.indexOf('读坏') >= 0;
  }

  /** 标题下面那行:平时是模型;在压缩、等你、出问题时说清楚。 */
  private subtitle(): string {
    if (this.badStatus() || this.status === '正在压缩前面的对话' || this.status === '等待写文件') {
      return this.status;
    }
    if (!this.configured) {
      return '还没配 AI 服务商';
    }
    return this.modelLine.length > 0 ? this.modelLine : '选一个模型';
  }

  private agentName(): string {
    const name = soulStore.name();
    return name.length > 0 ? name : 'LeoPhoneAgent';
  }

  private boot(): void {
    this.alive = true;
    this.currentId = this.sessionId;
    const ctx = getContext(this) as common.UIAbilityContext;
    Promise.all([
      providerStore.ensureLoaded(ctx),
      sessionStore.ensureLoaded(ctx),
      LocalTools.hydrate(ctx)
    ]).then(() => {
      if (!this.alive) {
        return;
      }
      this.configured = providerStore.configured();
      this.fullAuto = SensitiveToolGate.fullAuto;
      this.refreshSlot();
      this.ready = true;
      if (themeStore.expandThinking && this.thinking.length === 0) {
        this.thinking = 'medium';
      }
      if (sessionStore.jsonLoadFailed) {
        this.status = '对话档案读坏了，先别保存';
        return;
      }
      if (!this.currentId) {
        this.status = this.configured ? '空闲' : '未配置 AI 服务商';
        this.title = 'LeoPhoneAgent';
        return;
      }
      this.attach(ctx, this.currentId);
      if (!this.configured) {
        this.status = '未配置 AI 服务商';
      }
    }).catch((err: Error) => {
      this.status = `${err}`;
    });
  }

  private attach(ctx: common.UIAbilityContext, id: string): ChatRun {
    this.detach();
    const run = ChatRuns.open(ctx, id);
    run.viewers += 1;
    this.run = run;
    run.load().then(() => {
      if (this.run === run) {
        this.sync();
        this.followTail(true);
        const first = LocalChatLaunch.first;
        if (first && first.sessionId === id) {
          LocalChatLaunch.first = null;
          run.send(first.text, first.image, first.files, this.thinking);
        }
      }
    }).catch((err: Error) => {
      this.status = `${err}`;
    });
    return run;
  }

  private detach(): void {
    if (this.run) {
      this.run.viewers = Math.max(0, this.run.viewers - 1);
      this.run = null;
    }
  }

  /** 把对话的状态抄到页面上(对话每变一次 ChatRuns 就拨一下 chatTick)。 */
  private sync(): void {
    const run = this.run;
    if (!run || !this.alive || !run.loaded) {
      return;
    }
    const grew = run.lines.length !== this.lines.length;
    const mine = run.lines.length > 0 && run.lines[run.lines.length - 1].role === 'user';
    // 刚说完:回答下面多出复制、朗读那一排,跟着滚到底才看得见
    const ended = this.active && !run.active;
    if (this.tailOnly(run)) {
      this.lines = run.lines;
      this.liveText = run.lines[run.lines.length - 1].text;
    } else if (run.lines !== this.lines || run.active !== this.active || run.askWrite !== this.askWrite) {
      this.lines = run.lines;
      // 等你确认写文件时这一轮还没完:没跑的那步算「在跑」,不是「没跑完」
      this.items = chatItems(textLines(run.lines), run.active || run.askWrite, this.openTurns, !themeStore.toolPreview);
      const tail = this.items.length > 0 ? this.items[this.items.length - 1] : undefined;
      this.liveText = tail !== undefined && tail.live ? tail.text : '';
    }
    this.shown = run.lines;
    this.status = run.status;
    this.title = run.title;
    this.active = run.active;
    this.interrupted = run.interrupted;
    this.askWrite = run.askWrite;
    this.askTitle = run.askWrite ? run.writeAskTitle() : '';
    if (grew && !this.nearBottom && !mine) {
      this.unseen = true;
    }
    if (grew || run.active || ended) {
      // 自己发的消息总是滚到底;别的只在本来就在底部附近时跟随。
      this.followTail(grew && mine);
    }
  }

  /** 流式输出的一帧:只有最后一段回答多了几个字 —— 只刷那段字,列表不重排。 */
  private tailOnly(run: ChatRun): boolean {
    const next = run.lines;
    const n = next.length;
    if (this.liveText.length === 0 || !run.active || run.askWrite || n === 0 || n !== this.shown.length ||
      next[n - 1].role !== 'assistant') {
      return false;
    }
    for (let i = 0; i < n - 1; i++) {
      if (next[i] !== this.shown[i]) {
        return false;
      }
    }
    return true;
  }

  private toggleTurn(turn: number): void {
    this.openTurns = this.openTurns.indexOf(turn) >= 0 ? this.openTurns.filter((t: number) => t !== turn) :
      this.openTurns.concat([turn]);
    this.items = chatItems(textLines(this.lines), this.active || this.askWrite, this.openTurns, !themeStore.toolPreview);
  }

  private lineImage(index: number): string {
    return index >= 0 && index < this.lines.length ? this.lines[index].imagePath : '';
  }

  private lineFiles(index: number): string[] {
    return index >= 0 && index < this.lines.length ? this.lines[index].files : [];
  }

  /** 对最后一句话的回答:下面多一个「重新生成」(它重做的是最后一句,不能挂在更早的回答下面)。 */
  private isLatest(item: ChatItem): boolean {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].kind === 'user') {
        return false;
      }
      if (this.items[i].kind === 'assistant' && this.items[i].last) {
        return this.items[i].index === item.index;
      }
    }
    return false;
  }

  private lastIsError(): boolean {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].kind === 'notice') {
        continue;
      }
      return this.items[i].kind === 'error';
    }
    return false;
  }

  /** 最后那条错误旁边给「继续」;更早的错误只显示。 */
  private errorAction(item: ChatItem): string {
    if (this.active || !this.interrupted) {
      return '';
    }
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].kind === 'notice') {
        continue;
      }
      return this.items[i].index === item.index && this.items[i].kind === 'error' ? '继续' : '';
    }
    return '';
  }

  private async send(): Promise<void> {
    const text = this.draft.trim();
    if (!text && !this.image && this.pendingFiles.length === 0) {
      return;
    }
    this.slashOpen = false;
    const ctx = getContext(this) as common.UIAbilityContext;
    let run = this.run;
    if (!this.currentId || !run) {
      try {
        const session = await sessionStore.create(ctx);
        this.currentId = session.id;
        LocalChatLaunch.sessionId = session.id;
        run = this.attach(ctx, session.id);
        await run.load();
      } catch (err) {
        this.status = `${err}`;
        return;
      }
    }
    const image = this.image;
    const files = this.pendingFiles;
    this.draft = '';
    this.image = null;
    this.pendingFiles = [];
    this.pendingImagePath = '';
    await run.send(text, image, files, this.thinking);
  }

  private pickSlash(cmd: SlashCommand): void {
    this.slashOpen = false;
    if (cmd.now) {
      this.runCommand(cmd.name);
      return;
    }
    this.draft = `${cmd.name} `;
  }

  private runCommand(cmd: string): void {
    if (this.run) {
      this.run.send(cmd, null, [], this.thinking);
    }
  }

  private async newSession(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      const session = await sessionStore.create(ctx);
      this.currentId = session.id;
      LocalChatLaunch.sessionId = session.id;
      this.lines = [];
      this.items = [];
      this.openTurns = [];
      this.attach(ctx, session.id);
    } catch (err) {
      this.status = `${err}`;
    }
  }

  private async exportSession(): Promise<void> {
    if (!this.currentId) {
      return;
    }
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      this.copyText(await sessionStore.exportSession(ctx, this.currentId));
      this.status = '已复制这条对话,在另一台设备的「导入对话」里粘贴';
    } catch (err) {
      this.status = `${err}`;
    }
  }

  private allowWrite(sessionWide: boolean): void {
    if (this.run) {
      this.run.allowWrite(sessionWide);
    }
  }

  private denyWrite(stop: boolean): void {
    if (this.run) {
      this.run.denyWrite(stop);
    }
  }

  private async toggleFullAuto(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    await SensitiveToolGate.setFullAuto(ctx, !SensitiveToolGate.fullAuto);
    this.fullAuto = SensitiveToolGate.fullAuto;
    if (this.run) {
      this.run.onFullAuto();
    }
  }

  private regenerate(): void {
    if (this.run && !this.active) {
      this.run.regenerate(this.thinking);
    }
  }

  private async toggleListen(): Promise<void> {
    if (this.stopListen) {
      this.stopListen();
      this.stopListen = null;
      this.listening = false;
      return;
    }
    try {
      this.listening = true;
      const ctx = getContext(this) as common.UIAbilityContext;
      this.stopListen = await Voice.listen(ctx, (text: string, last: boolean) => {
        this.draft = text;
        if (last) {
          this.listening = false;
          this.stopListen = null;
        }
      }, (message: string) => {
        this.status = message;
        this.listening = false;
        this.stopListen = null;
      });
    } catch (err) {
      this.status = `${err}`;
      this.listening = false;
      this.stopListen = null;
    }
  }

  private readLast(): void {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      if (this.lines[i].role === 'assistant' && this.lines[i].text.length > 0) {
        this.speak(this.lines[i].text);
        return;
      }
    }
  }

  private speak(text: string): void {
    Voice.speak(text).catch((err: Error) => {
      this.status = `${err}`;
    });
  }

  private copyText(text: string): void {
    if (text.length === 0) {
      return;
    }
    try {
      pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text));
    } catch (err) {
      this.status = `${err}`;
    }
  }

  private async pickImage(): Promise<void> {
    try {
      const image = await Attachments.pickImage(getContext(this) as common.UIAbilityContext);
      if (image) {
        this.image = image;
        this.pendingImagePath = image.path;
      }
    } catch (err) {
      this.status = err instanceof Error ? err.message : `${err}`;
    }
  }

  private async pickFiles(): Promise<void> {
    try {
      const picked = await Attachments.pickFiles(getContext(this) as common.UIAbilityContext);
      this.pendingFiles = this.pendingFiles.concat(picked.names);
      if (picked.skipped > 0) {
        this.status = `有 ${picked.skipped} 个文件超过 20MB,没带上`;
      }
    } catch (err) {
      this.status = err instanceof Error ? err.message : `${err}`;
    }
  }

  private followTail(force: boolean = false): void {
    if (this.items.length === 0 || (!force && !this.nearBottom)) {
      return;
    }
    this.nearBottom = true;
    this.showDown = false;
    this.unseen = false;
    const index = this.items.length - 1;
    setTimeout(() => {
      try {
        this.chatScroller.scrollToIndex(index, false, ScrollAlign.END);
        this.chatScroller.scrollEdge(Edge.Bottom);
      } catch (_err) {
        // list not attached yet
      }
    }, 0);
  }
}
