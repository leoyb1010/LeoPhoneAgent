import { common } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { pasteboard } from '@kit.BasicServicesKit';
import { router } from '@kit.ArkUI';
import { ChatRun, ChatRuns, PendingImage } from '../local/ChatRun';
import { InAppBrowser } from '../local/InAppBrowser';
import { Voice } from '../local/Voice';
import { MarkdownText } from '../theme/Markdown';
import { LocalChatMessage, extractLinks, nextThinking, thinkingLabel } from '../local/LocalProtocol';
import { LocalTools } from '../local/LocalTools';
import { SensitiveToolGate } from '../local/SensitiveToolGate';
import { ProviderInstance, providerStore } from '../store/ProviderStore';
import { themeStore } from '../store/ThemeStore';
import { SessionStore, sessionStore } from '../store/SessionStore';
import { WorkspaceStore } from '../store/WorkspaceStore';
import { Copy } from '../theme/Copy';
import { IconBtn, StatusPill, SysIcon } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

export class LocalChatLaunch {
  static sessionId: string = '';
}

@Component
export struct LocalChatPane {
  @StorageProp('themeTick') tick: number = 0;
  @StorageProp('providerTick') @Watch('onProviderTick') providerTick: number = 0;
  @StorageProp('chatTick') @Watch('onChatTick') chatTick: number = 0;
  @Prop @Watch('onSessionChange') sessionId: string = '';
  @StorageProp('approvalTick') @Watch('onApprovalTick') approvalTick: number = 0;
  @Prop compact: boolean = false;
  @State lines: LocalChatMessage[] = [];
  @State fullAuto: boolean = false;
  @State title: string = '本机 Agent';
  @State draft: string = '';
  @State status: string = '准备中';
  @State configured: boolean = false;
  @State ready: boolean = false;
  @State thinking: string = '';
  @State askWrite: boolean = false;
  @State askTitle: string = '';
  /** 有一轮在跑:显示「停止」。 */
  @State active: boolean = false;
  /** 上一轮没做完:显示「继续」。 */
  @State interrupted: boolean = false;
  @State imageHint: string = '';
  @State listening: boolean = false;
  @State slotLabel: string = '';
  @State pickerOpen: boolean = false;
  @State pickerRows: ProviderInstance[] = [];
  @State pickerOpenId: string = '';
  @State hasProviders: boolean = false;
  /** 点开看的那个压缩摘要(下标),-1 都收着。 */
  @State openSummary: number = -1;
  private image: PendingImage | null = null;
  private files: string[] = [];
  private chatScroller: Scroller = new Scroller();
  private alive: boolean = false;
  private currentId: string = '';
  /** 这个页面在看的对话。一轮跑在它里面,离开页面、切走都不作废(见 ChatRun)。 */
  private run: ChatRun | null = null;
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
        this.status = this.currentId ? '空闲' : '本机就绪';
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
    this.draft = '';
    this.image = null;
    this.files = [];
    this.imageHint = '';
    this.openSummary = -1;
    this.active = false;
    this.interrupted = false;
    this.askWrite = false;
    this.boot();
  }

  build() {
    Column() {
      Row() {
        if (!this.compact) {
          SysIcon({
            name: 'back',
            dim: 22,
            color: Tokens.text
          })
            .width(28)
            .height(28)
            .margin({ right: 4 })
            .onClick(() => {
              router.back();
            })
        }
        Column() {
          Text(themeStore.showTitle ? this.title : '本机')
            .fontSize(this.compact ? 16 : 19)
            .fontWeight(FontWeight.Medium)
            .fontColor(Tokens.text)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(this.status)
            .fontSize(12)
            .fontColor(this.badStatus() ? Tokens.warn : Tokens.muted)
            .margin({ top: 2 })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
        Text(thinkingLabel(this.thinking))
          .fontSize(12)
          .fontColor(Tokens.link)
          .padding({ left: 10, right: 10, top: 6, bottom: 6 })
          .backgroundColor(Tokens.surface)
          .borderRadius(50)
          .onClick(() => {
            this.thinking = nextThinking(this.thinking);
          })
        IconBtn({
          name: 'sound',
          box: 32,
          glyph: 16,
          color: Tokens.link,
          fill: Tokens.surface,
          onTap: () => {
            this.readLast();
          }
        })
          .margin({ left: 8 })
        // 出错、停止之后也能重新生成(原来只在「空闲」时出现,报错后反而没有)。
        if (!this.active && !this.askWrite && this.hasUser()) {
          IconBtn({
            name: 'restore',
            box: 32,
            glyph: 16,
            color: Tokens.link,
            fill: Tokens.surface,
            onTap: () => {
              this.regenerate();
            }
          })
            .margin({ left: 8 })
        }
      }
      .width('100%')
      .height(Tokens.chatBar)
      .alignItems(VerticalAlign.Center)
      .padding({ left: Tokens.pagePad, right: Tokens.pagePad })

      if (this.hasProviders) {
        Row() {
          Text(this.slotLabel.length > 0 ? this.slotLabel : '还没选好当前 AI 服务商')
            .fontSize(12)
            .fontColor(Tokens.link)
            .layoutWeight(1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Text(this.pickerOpen ? '收起' : '切换')
            .fontSize(12)
            .fontColor(Tokens.muted)
        }
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 8 })
        .onClick(() => {
          this.pickerOpen = !this.pickerOpen;
          if (this.pickerOpen) {
            this.pickerRows = providerStore.instances.slice();
            this.pickerOpenId = providerStore.activeId;
          }
        })
      }
      if (this.pickerOpen) {
        this.slotPicker()
      }

      if (!this.configured) {
        this.centerCopy('先配一个 AI 服务商', '设置 → AI 服务商，先选类型再填钥匙。不连中继也能聊。')
      } else if (this.currentId.length === 0) {
        this.emptyWorkspace()
      } else if (this.lines.length === 0) {
        this.emptyWorkspace()
      } else {
        List({ scroller: this.chatScroller }) {
          ForEach(this.lines, (line: LocalChatMessage, index: number) => {
            ListItem() {
              this.bubble(line, index)
            }
            .padding({ left: Tokens.pagePad, right: Tokens.pagePad, top: 4, bottom: 4 })
            // key 里原来带 line.text.length。流式输出时最后一条的长度每 16ms 变一次，
            // key 跟着变 → ArkUI 把整个 ListItem 销毁重建（连 MarkdownText 对整段文本的
            // 重新分块也一起重来），长回复期间就是持续 60Hz 的全量重建。
            // 去掉长度后 key 稳定，文本变化走属性更新即可。
          }, (line: LocalChatMessage, index: number) => `${index}:${line.role}`)
        }
        .layoutWeight(1)
        .width('100%')
        .scrollBar(BarState.Off)
        .onScrollIndex((start: number, end: number) => {
          // 往上翻着看旧消息时,流式输出不再把你拽回底部。
          this.nearBottom = end >= this.lines.length - 2;
        })
      }

      if (this.askWrite) {
        Column() {
          Text(this.askTitle)
            .fontSize(13)
            .fontColor(Tokens.warn)
            .width('100%')
          Row() {
            Button('允许一次')
              .layoutWeight(1)
              .height(36)
              .fontSize(14)
              .backgroundColor(Tokens.online)
              .fontColor('#000000')
              .onClick(() => {
                this.allowWrite(false);
              })
            Button('本次会话允许')
              .layoutWeight(1)
              .height(36)
              .fontSize(14)
              .margin({ left: 8 })
              .backgroundColor(Tokens.surface2)
              .fontColor(Tokens.text)
              .onClick(() => {
                this.allowWrite(true);
              })
            Button('拒绝')
              .layoutWeight(1)
              .height(36)
              .fontSize(14)
              .margin({ left: 8 })
              .backgroundColor(Tokens.surface2)
              .fontColor(Tokens.text)
              .onClick(() => {
                this.denyWrite(false);
              })
          }
          .width('100%')
          .margin({ top: 8 })
          Text('拒绝并停止任务')
            .fontSize(13)
            .fontColor(Tokens.muted)
            .margin({ top: 8 })
            .onClick(() => {
              this.denyWrite(true);
            })
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 8 })
      }

      if (this.interrupted && !this.active && !this.askWrite && this.currentId.length > 0) {
        Row() {
          Text('已中断 · 点「继续」接着做')
            .fontSize(13)
            .fontColor(Tokens.warn)
            .layoutWeight(1)
          Button('继续')
            .height(32)
            .fontSize(14)
            .backgroundColor(Tokens.online)
            .fontColor('#000000')
            .onClick(() => {
              if (this.run) {
                this.run.resume(this.thinking);
              }
            })
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 6 })
      }

      if (this.currentId.length > 0) {
        Row() {
          Text(`审批 · ${this.fullAuto ? '全自动' : '逐项确认'}`)
            .fontSize(12)
            .fontColor(this.fullAuto ? Tokens.warn : Tokens.muted)
            .padding({ left: 10, right: 10, top: 4, bottom: 4 })
            .backgroundColor(Tokens.surface)
            .borderRadius(50)
            .onClick(() => {
              this.toggleFullAuto();
            })
        }
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 4 })
        if (this.imageHint.length > 0) {
          Text(this.imageHint)
            .fontSize(12)
            .fontColor(Tokens.link)
            .width('100%')
            .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 4 })
        }
        Row() {
          if (!this.active) {
            IconBtn({
              name: this.listening ? 'pause' : 'voice',
              box: Tokens.sendSize,
              glyph: 20,
              color: Tokens.text,
              fill: Tokens.surface2,
              onTap: () => {
                this.toggleListen();
              }
            })
              .margin({ right: 8 })
            IconBtn({
              name: 'camera',
              box: Tokens.sendSize,
              glyph: 20,
              color: Tokens.text,
              fill: Tokens.surface2,
              onTap: () => {
                this.pickImage();
              }
            })
              .margin({ right: 8 })
            // 附文件(PDF、文档、图片……):放进沙箱,模型自己用 file_read / read_image 读
            IconBtn({
              name: 'add',
              box: Tokens.sendSize,
              glyph: 20,
              color: Tokens.text,
              fill: Tokens.surface2,
              onTap: () => {
                this.pickFiles();
              }
            })
              .margin({ right: 8 })
          }
          TextInput({ placeholder: '说要做什么', text: this.draft })
            .layoutWeight(1)
            .height(Tokens.composerH)
            .backgroundColor(Tokens.surface)
            .fontColor(Tokens.text)
            .placeholderColor(Tokens.muted)
            .borderRadius(Tokens.composerRadius)
            .padding({ left: 14, right: 14 })
            .onChange((value: string) => {
              this.draft = value;
            })
            .onSubmit(() => {
              if (themeStore.returnSend) {
                this.send();
              }
            })
          if (this.active) {
            Button('停止')
              .height(Tokens.composerH)
              .margin({ left: 8 })
              .padding({ left: 14, right: 14 })
              .backgroundColor(Tokens.surface2)
              .fontColor(Tokens.text)
              .onClick(() => {
                if (this.run) {
                  this.run.stop();
                }
              })
          } else {
            Button('发送')
              .height(Tokens.composerH)
              .margin({ left: 8 })
              .padding({ left: 16, right: 16 })
              .backgroundColor(Tokens.send)
              .fontColor(Tokens.sendGlyph)
              .enabled(this.ready)
              .onClick(() => {
                this.send();
              })
          }
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 16, top: 8 })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }

  @Builder
  bubble(line: LocalChatMessage, index: number) {
    if (line.kind === 'summary') {
      Column() {
        Text(`已压缩前面 ${line.count} 条消息 · ${this.openSummary === index ? '收起摘要' : '点开看摘要'}`)
          .fontSize(12)
          .fontColor(Tokens.muted)
        if (this.openSummary === index) {
          MarkdownText({ text: line.text, color: Tokens.muted, fill: false })
            .margin({ top: 6 })
        }
      }
      .width('100%')
      .alignItems(HorizontalAlign.Center)
      .padding({ top: 6, bottom: 6 })
      .onClick(() => {
        this.openSummary = this.openSummary === index ? -1 : index;
      })
    } else {
      this.messageRow(line)
    }
  }

  @Builder
  messageRow(line: LocalChatMessage) {
    Row() {
      if (line.role === 'user') {
        Blank()
          .layoutWeight(1)
          .constraintSize({ minWidth: 48 })
      }
      Column() {
        if (line.role === 'assistant') {
          MarkdownText({ text: line.text, color: Tokens.text, fill: false })
        } else {
          if (line.imagePath.length > 0) {
            Image(line.imagePath)
              .width(160)
              .height(160)
              .objectFit(ImageFit.Cover)
              .borderRadius(12)
              .margin({ bottom: 8 })
          }
          Text(line.text)
            .fontSize(16)
            .fontColor(Tokens.userText)
          ForEach(line.files, (name: string) => {
            Text(`附件 · ${name}`)
              .fontSize(13)
              .fontColor(Tokens.userText)
              .opacity(0.8)
              .margin({ top: 4 })
          }, (name: string) => name)
        }
        if (line.role === 'assistant') {
          ForEach(extractLinks(line.text), (link: string) => {
            Text('打开链接')
              .fontSize(13)
              .fontColor(Tokens.link)
              .margin({ top: 6 })
              .onClick(() => {
                const err = InAppBrowser.open(link);
                if (err.length > 0) {
                  this.status = err;
                }
              })
          }, (link: string) => link)
        }
      }
      .alignItems(HorizontalAlign.Start)
      .padding({ left: 14, right: 14, top: 10, bottom: 10 })
      .backgroundColor(line.role === 'user' ? Tokens.userBubble : Tokens.surface)
      .borderRadius(Tokens.bubbleRadius)
      .constraintSize({ maxWidth: Tokens.bubbleMax })
      .clip(true)
      if (line.role !== 'user') {
        Blank()
          .layoutWeight(1)
          .constraintSize({ minWidth: 48 })
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
    .gesture(
      LongPressGesture({ repeat: false }).onAction(() => {
        this.copyLine(line.text);
      })
    )
  }

  @Builder
  emptyWorkspace() {
    Scroll() {
      Column() {
        Stack() {
          Column()
            .width(this.compact ? Tokens.heroCompact : Tokens.hero)
            .height(this.compact ? Tokens.heroCompact : Tokens.hero)
            .borderRadius(this.compact ? 17 : 22)
            .linearGradient({
              angle: 135,
              colors: [[Tokens.heroA, 0], [Tokens.heroB, 1]]
            })
          Text('本')
            .fontSize(this.compact ? 24 : 30)
            .fontColor('#FFFFFF')
            .fontWeight(FontWeight.Bold)
        }
        .width(this.compact ? Tokens.heroCompact : Tokens.hero)
        .height(this.compact ? Tokens.heroCompact : Tokens.hero)
        .margin({ bottom: this.compact ? 9 : 18 })

        Text(Copy.readyTitle)
          .fontSize(this.compact ? 20 : 23)
          .fontWeight(FontWeight.Bold)
          .fontColor(Tokens.text)
        Text(Copy.readySubtitle)
          .fontSize(14)
          .fontColor(Tokens.muted)
          .textAlign(TextAlign.Center)
          .margin({ top: 7, bottom: 14 })
        Row() {
          StatusPill({ label: Copy.localBadge, dot: Tokens.online })
          StatusPill({ label: Copy.privateBadge, dot: Tokens.heroB })
            .margin({ left: 8 })
        }
        .margin({ bottom: this.compact ? 10 : 24 })
        this.quickTask(Copy.taskPhone, Copy.promptPhone, Tokens.heroA)
        this.quickTask(Copy.taskResearch, Copy.promptResearch, Tokens.heroB)
        this.quickTask(Copy.taskAutomate, Copy.promptAutomate, Tokens.warn)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Center)
      .padding({
        left: this.compact ? 18 : 24,
        right: this.compact ? 18 : 24,
        top: this.compact ? 10 : 22,
        bottom: 16
      })
    }
    .layoutWeight(1)
    .align(Alignment.Top)
    .scrollBar(BarState.Off)
  }

  @Builder
  quickTask(title: string, prompt: string, color: string) {
    Row() {
      Stack() {
        Column()
          .width(this.compact ? 30 : 34)
          .height(this.compact ? 30 : 34)
          .borderRadius(11)
          .backgroundColor(color)
          .opacity(0.22)
        Text('→')
          .fontSize(this.compact ? 16 : 18)
          .fontColor(color)
      }
      .width(this.compact ? 30 : 34)
      .height(this.compact ? 30 : 34)
      Text(title)
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor(Tokens.text)
        .margin({ left: Tokens.rowGap })
        .layoutWeight(1)
      Text('›')
        .fontSize(18)
        .fontColor(Tokens.muted)
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: this.compact ? 8 : 12, bottom: this.compact ? 8 : 12 })
    .margin({ bottom: this.compact ? 6 : 9 })
    .backgroundColor(Tokens.surface)
    .borderRadius(Tokens.cardRadius)
    .onClick(() => {
      this.draft = prompt;
      if (this.currentId.length === 0) {
        this.status = '先在左边开一个新任务';
      }
    })
  }

  @Builder
  slotPicker() {
    Scroll() {
      Column() {
        ForEach(this.pickerRows, (row: ProviderInstance) => {
          Column() {
            Text(row.label.length > 0 ? row.label : row.type)
              .fontSize(13)
              .fontColor(providerStore.activeId === row.id ? Tokens.link : Tokens.muted)
              .width('100%')
              .padding({ bottom: 4 })
              .onClick(() => {
                if (this.pickerOpenId !== row.id) {
                  this.pickerOpenId = row.id;
                  return;
                }
                const pick = row.model.length > 0 ? row.model : (this.slotModels(row)[0] ?? '');
                if (pick.length > 0) {
                  this.useSlot(row.id, pick);
                }
              })
            if (this.pickerOpenId === row.id) {
              ForEach(this.slotModels(row), (id: string) => {
                Text(id)
                  .fontSize(14)
                  .fontColor(providerStore.activeId === row.id && row.model === id ? Tokens.link : Tokens.text)
                  .width('100%')
                  .padding({ top: 6, bottom: 6 })
                  .onClick(() => {
                    this.useSlot(row.id, id);
                  })
              }, (id: string) => `${row.id}/${id}`)
            }
          }
          .width('100%')
          .padding({ bottom: 10 })
        }, (row: ProviderInstance) => row.id)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
      .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 8 })
    }
    .constraintSize({ maxHeight: 180 })
    .scrollBar(BarState.Off)
  }

  @Builder
  centerCopy(title: string, body: string) {
    Column() {
      Text(title)
        .fontSize(20)
        .fontColor(Tokens.text)
      Text(body)
        .fontSize(14)
        .fontColor(Tokens.muted)
        .margin({ top: 8 })
        .textAlign(TextAlign.Center)
    }
    .layoutWeight(1)
    .width('100%')
    .justifyContent(FlexAlign.Center)
    .padding(24)
  }

  private refreshSlot(): void {
    const row = providerStore.active();
    this.hasProviders = providerStore.instances.length > 0;
    if (!row) {
      this.slotLabel = '';
      return;
    }
    this.slotLabel = row.model.length > 0 ? `${row.label} · ${row.model}` : `${row.label} · 还没选模型`;
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
      this.pickerOpen = false;
      this.status = this.configured ? (this.currentId ? '空闲' : '本机就绪') : '未配置 AI 服务商';
    }).catch((err: Error) => {
      this.status = `${err}`;
    });
  }

  private badStatus(): boolean {
    return this.status.indexOf('失败') >= 0 || this.status.indexOf('AI 服务商') >= 0 ||
      this.status.indexOf('断了') >= 0 || this.status.indexOf('中断') >= 0;
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
        this.status = this.configured ? '本机就绪' : '未配置 AI 服务商';
        this.title = '本机 Agent';
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
    this.lines = run.lines;
    this.status = run.status;
    this.title = run.title;
    this.active = run.active;
    this.interrupted = run.interrupted;
    this.askWrite = run.askWrite;
    this.askTitle = run.askWrite ? run.writeAskTitle() : '';
    if (grew || run.active) {
      // 自己发的消息总是滚到底;别的只在本来就在底部附近时跟随。
      this.followTail(grew && mine);
    }
  }

  private async send(): Promise<void> {
    const text = this.draft.trim();
    if (!text && !this.image && this.files.length === 0) {
      return;
    }
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
    const files = this.files;
    this.draft = '';
    this.image = null;
    this.files = [];
    this.imageHint = '';
    await run.send(text, image, files, this.thinking);
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
    this.status = this.fullAuto ? '已切到全自动:写文件不再逐项确认' : '已切回逐项确认';
    if (this.run) {
      this.run.onFullAuto();
    }
  }

  private regenerate(): void {
    if (this.run && !this.active) {
      this.run.regenerate(this.thinking);
    }
  }

  private hasUser(): boolean {
    for (let i = 0; i < this.lines.length; i++) {
      if (this.lines[i].role === 'user') {
        return true;
      }
    }
    return false;
  }

  private async toggleListen(): Promise<void> {
    if (this.stopListen) {
      this.stopListen();
      this.stopListen = null;
      this.listening = false;
      this.status = '空闲';
      return;
    }
    try {
      this.status = '在听';
      this.listening = true;
      const ctx = getContext(this) as common.UIAbilityContext;
      this.stopListen = await Voice.listen(ctx, (text: string, last: boolean) => {
        this.draft = text;
        if (last) {
          this.status = '空闲';
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
    let text = '';
    for (let i = this.lines.length - 1; i >= 0; i--) {
      if (this.lines[i].role === 'assistant' && this.lines[i].text.length > 0) {
        text = this.lines[i].text;
        break;
      }
    }
    Voice.speak(text).catch((err: Error) => {
      this.status = `${err}`;
    });
  }

  private copyLine(text: string): void {
    if (text.length === 0) {
      return;
    }
    try {
      const board = pasteboard.getSystemPasteboard();
      const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text);
      board.setData(data);
      this.status = '已复制';
    } catch (err) {
      this.status = `${err}`;
    }
  }

  private async pickImage(): Promise<void> {
    try {
      const options = new picker.PhotoSelectOptions();
      options.MIMEType = picker.PhotoViewMIMETypes.IMAGE_TYPE;
      options.maxSelectNumber = 1;
      const chosen = await new picker.PhotoViewPicker().select(options);
      if (!chosen || !chosen.photoUris || chosen.photoUris.length === 0) {
        return;
      }
      const uri = chosen.photoUris[0];
      const file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
      try {
        const stat = fileIo.statSync(file.fd);
        // 超过 4MB 明说,不发半张图(原来只读前 4MB,得到一张截断的 JPEG)。
        if (stat.size > 4 * 1024 * 1024) {
          this.status = '这张图超过 4MB，换一张小的';
          return;
        }
        const buf = new ArrayBuffer(stat.size);
        fileIo.readSync(file.fd, buf);
        const ctx = getContext(this) as common.UIAbilityContext;
        const image = new PendingImage();
        image.b64 = new util.Base64Helper().encodeToStringSync(new Uint8Array(buf));
        image.mime = uri.toLowerCase().indexOf('.png') >= 0 ? 'image/png' : 'image/jpeg';
        image.path = SessionStore.writeImageBytes(ctx, buf, image.mime);
        this.image = image;
        this.refreshAttachHint();
      } finally {
        fileIo.closeSync(file);
      }
    } catch (err) {
      this.status = `${err}`;
    }
  }

  /**
   * 附文件:复制进沙箱,消息里只带文件名清单,模型自己用 file_read / read_image 读 ——
   * 和 iOS、安卓一样不把正文塞进消息。单个文件最多 20MB。
   */
  private async pickFiles(): Promise<void> {
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const options = new picker.DocumentSelectOptions();
      options.maxSelectNumber = 5;
      const uris = await new picker.DocumentViewPicker(ctx).select(options);
      if (!uris || uris.length === 0) {
        return;
      }
      for (let i = 0; i < uris.length; i++) {
        const file = fileIo.openSync(uris[i], fileIo.OpenMode.READ_ONLY);
        try {
          const size = fileIo.statSync(file.fd).size;
          if (size > 20 * 1024 * 1024) {
            this.status = '有个文件超过 20MB,没带上';
            continue;
          }
          const buf = new ArrayBuffer(size);
          fileIo.readSync(file.fd, buf);
          const raw = uris[i].substring(uris[i].lastIndexOf('/') + 1);
          let name = raw;
          try {
            name = decodeURIComponent(raw);
          } catch (_err) {
            name = raw;
          }
          this.files = this.files.concat([WorkspaceStore.saveUpload(ctx, name, buf)]);
        } finally {
          fileIo.closeSync(file);
        }
      }
      this.refreshAttachHint();
    } catch (err) {
      this.status = `${err}`;
    }
  }

  private refreshAttachHint(): void {
    const parts: string[] = [];
    if (this.image) {
      parts.push('一张图');
    }
    if (this.files.length > 0) {
      parts.push(`文件 ${this.files.join('、')}`);
    }
    this.imageHint = parts.length > 0 ? `已选${parts.join(',')},发送时带上` : '';
  }

  private followTail(force: boolean = false): void {
    if (this.lines.length === 0 || (!force && !this.nearBottom)) {
      return;
    }
    this.nearBottom = true;
    const index = this.lines.length - 1;
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
