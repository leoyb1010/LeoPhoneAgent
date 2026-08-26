import { http } from '@kit.NetworkKit';
import { common } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { pasteboard } from '@kit.BasicServicesKit';
import { router } from '@kit.ArkUI';
import { InAppBrowser } from '../local/InAppBrowser';
import { Voice } from '../local/Voice';
import { MarkdownText } from '../theme/Markdown';
import {
  LocalChatMessage,
  LoopTurn,
  ToolCall,
  extractLinks,
  nextThinking,
  shouldFailover,
  thinkingLabel
} from '../local/LocalProtocol';
import { usageStore } from '../store/UsageStore';
import { FastLocalActions } from '../local/FastLocalActions';
import { LocalTools, ToolResult } from '../local/LocalTools';
import { taskStatus } from '../store/TaskStatus';
import { OpenAICompatClient, StreamTurn } from '../local/OpenAICompatClient';
import { SensitiveToolGate } from '../local/SensitiveToolGate';
import { memoryStore } from '../store/MemoryStore';
import { ProviderInstance, providerStore } from '../store/ProviderStore';
import { themeStore } from '../store/ThemeStore';
import { LocalSession, SessionStore, sessionStore } from '../store/SessionStore';
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
  @Prop @Watch('onSessionChange') sessionId: string = '';
  @Prop compact: boolean = false;
  @State lines: LocalChatMessage[] = [];
  @State title: string = '本机 Agent';
  @State draft: string = '';
  @State status: string = '准备中';
  @State configured: boolean = false;
  @State ready: boolean = false;
  @State thinking: string = '';
  @State askWrite: boolean = false;
  @State imageHint: string = '';
  @State listening: boolean = false;
  @State slotLabel: string = '';
  @State pickerOpen: boolean = false;
  @State pickerRows: ProviderInstance[] = [];
  @State pickerOpenId: string = '';
  @State hasProviders: boolean = false;
  private imageB64: string = '';
  private imageMime: string = 'image/jpeg';
  private imagePath: string = '';
  private stream: http.HttpRequest | null = null;
  private streamBuf: string = '';
  private streamTick: number = -1;
  private streamDone: boolean = false;
  private chatScroller: Scroller = new Scroller();
  private assistantOpen: boolean = false;
  private alive: boolean = false;
  private currentId: string = '';
  private loopTurns: LoopTurn[] = [];
  private pendingCalls: ToolCall[] = [];
  private rounds: number = 0;
  private failIndex: number = 0;
  private stopListen: (() => void) | null = null;

  aboutToAppear(): void {
    this.boot();
  }

  onProviderTick(): void {
    if (this.alive) {
      this.configured = providerStore.configured();
      this.refreshSlot();
      if (this.status === '未配置供应商' && this.configured) {
        this.status = this.currentId ? '空闲' : '本机就绪';
      }
    }
  }

  aboutToDisappear(): void {
    this.alive = false;
    this.stopStream();
    if (this.stopListen) {
      this.stopListen();
      this.stopListen = null;
      this.listening = false;
    }
  }

  onSessionChange(): void {
    this.stopStream();
    this.lines = [];
    this.draft = '';
    this.assistantOpen = false;
    // 切会话时这几个也得清。之前只清了 lines/draft，
    // 于是上一个会话没答完的「允许写这次」横条和它挂着的 pendingCalls 会留到新会话里，
    // 用户在新会话点允许，跑的是旧会话的工具调用。
    this.askWrite = false;
    taskStatus.setPendingWrite(false);
    this.pendingCalls = [];
    this.loopTurns = [];
    this.rounds = 0;
    this.failIndex = 0;
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
        if (this.status === '空闲' && this.hasUser()) {
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
          Text(this.slotLabel.length > 0 ? this.slotLabel : '还没选好当前供应商')
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
        this.centerCopy('先配本机供应商', '设置 → 管理供应商，先选类型再填钥匙。不连中继也能聊。')
      } else if (this.currentId.length === 0) {
        this.emptyWorkspace()
      } else if (this.lines.length === 0) {
        this.emptyWorkspace()
      } else {
        List({ scroller: this.chatScroller }) {
          ForEach(this.lines, (line: LocalChatMessage, index: number) => {
            ListItem() {
              this.bubble(line)
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
      }

      if (this.askWrite) {
        Row() {
          Text('写沙箱文件需要你点头')
            .fontSize(13)
            .fontColor(Tokens.warn)
            .layoutWeight(1)
          Button('允许写这次')
            .height(36)
            .backgroundColor(Tokens.online)
            .fontColor('#000000')
            .onClick(() => {
              // 授权带上本会话 id，避免被同时在跑的远程/定时回合抢走（见 SensitiveToolGate 注释）
              SensitiveToolGate.grantWriteOnce(this.grantOwner());
              this.askWrite = false;
              taskStatus.setPendingWrite(false);
              this.status = '已允许写这次';
              if (this.pendingCalls.length > 0) {
                const ctx = getContext(this) as common.UIAbilityContext;
                this.runTools(ctx, this.pendingCalls.slice());
              }
            })
        }
        .width('100%')
        .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 8 })
      }

      if (this.currentId.length > 0) {
        if (this.imageHint.length > 0) {
          Text(this.imageHint)
            .fontSize(12)
            .fontColor(Tokens.link)
            .width('100%')
            .padding({ left: Tokens.pagePad, right: Tokens.pagePad, bottom: 4 })
        }
        Row() {
          if (this.status !== '进行中') {
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
          if (this.status === '进行中') {
            Button('停止')
              .height(Tokens.composerH)
              .margin({ left: 8 })
              .padding({ left: 14, right: 14 })
              .backgroundColor(Tokens.surface2)
              .fontColor(Tokens.text)
              .onClick(() => {
                this.stopStream();
                taskStatus.setRunning(false);
                this.status = '已停止';
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
  bubble(line: LocalChatMessage) {
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
      this.status = this.configured ? (this.currentId ? '空闲' : '本机就绪') : '未配置供应商';
    }).catch((err: Error) => {
      this.status = `${err}`;
    });
  }

  /** 写沙箱授权的归属：本机聊天用会话 id，没会话时用一个本页固定标识 */
  private grantOwner(): string {
    return this.currentId.length > 0 ? this.currentId : 'localchat';
  }

  private badStatus(): boolean {
    return this.status.indexOf('失败') >= 0 || this.status === 'unauthorized';
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
      this.refreshSlot();
      this.ready = true;
      if (themeStore.expandThinking && this.thinking.length === 0) {
        this.thinking = 'medium';
      }
      if (sessionStore.jsonLoadFailed) {
        this.status = '会话档案读坏了，先别保存';
        return;
      }
      if (!this.configured) {
        this.status = '未配置供应商';
        return;
      }
      if (!this.currentId) {
        this.status = '本机就绪';
        this.title = '本机 Agent';
        return;
      }
      return sessionStore.get(ctx, this.currentId).then((session: LocalSession | null) => {
        if (!this.alive || !session) {
          this.status = '会话不在了';
          return;
        }
        this.title = session.title;
        this.lines = session.messages.slice();
        this.status = '空闲';
        this.followTail();
      });
    }).catch((err: Error) => {
      this.status = `${err}`;
    });
  }

  private stopStream(): void {
    this.clearStreamTick();
    this.streamBuf = '';
    this.streamDone = false;
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }
    this.assistantOpen = false;
  }

  private async send(): Promise<void> {
    const text = this.draft.trim();
    if (!text && this.imageB64.length === 0) {
      return;
    }
    const ctxEarly = getContext(this) as common.UIAbilityContext;
    if (text.length > 0) {
      const spoken = await FastLocalActions.tryRoute(ctxEarly, text, this.imageB64.length > 0 ? 1 : 0);
      if (spoken.length > 0) {
        this.draft = '';
        this.imageB64 = '';
        this.imageMime = 'image/jpeg';
        this.imagePath = '';
        this.imageHint = '';
        await this.finishNative(ctxEarly, text, spoken);
        return;
      }
    }
    if (!this.configured) {
      return;
    }
    this.draft = '';
    const attachB64 = this.imageB64;
    const attachMime = this.imageMime;
    const attachPath = this.imagePath;
    this.imageB64 = '';
    this.imageMime = 'image/jpeg';
    this.imagePath = '';
    this.imageHint = '';
    const ctx = getContext(this) as common.UIAbilityContext;
    if (!this.currentId) {
      try {
        const session = await sessionStore.create(ctx);
        this.currentId = session.id;
        LocalChatLaunch.sessionId = session.id;
      } catch (err) {
        this.status = `${err}`;
        return;
      }
    }
    if (text.startsWith('/')) {
      await this.runSlash(ctx, text);
      return;
    }
    try {
      const shown = (text.length > 0 ? text : '看这张图') + (attachB64.length > 0 ? '\n[图片]' : '');
      await sessionStore.append(ctx, this.currentId, 'user', shown, attachB64, attachMime, attachPath);
      this.push('user', shown, attachB64, attachMime, attachPath);
      const session = await sessionStore.get(ctx, this.currentId);
      if (session) {
        this.title = session.title;
      }
      this.status = '进行中';
      taskStatus.setRunning(true);
      this.rounds = 0;
      this.failIndex = 0;
      this.loopTurns = this.historyTurns();
      if (attachB64.length > 0 && this.loopTurns.length > 0) {
        const last = this.loopTurns[this.loopTurns.length - 1];
        last.imageB64 = attachB64;
        last.imageMime = attachMime;
      }
      this.startModel(ctx);
    } catch (err) {
      this.status = `${err}`;
    }
  }

  private async finishNative(ctx: common.UIAbilityContext, text: string, spoken: string): Promise<void> {
    if (!this.currentId) {
      try {
        const session = await sessionStore.create(ctx);
        this.currentId = session.id;
        LocalChatLaunch.sessionId = session.id;
      } catch (err) {
        this.status = `${err}`;
        return;
      }
    }
    try {
      await sessionStore.append(ctx, this.currentId, 'user', text);
      this.push('user', text);
      await sessionStore.append(ctx, this.currentId, 'assistant', spoken);
      this.push('assistant', spoken);
      const session = await sessionStore.get(ctx, this.currentId);
      if (session) {
        this.title = session.title;
      }
      this.status = '空闲';
    } catch (err) {
      this.status = `${err}`;
    }
  }

  private async runSlash(ctx: common.UIAbilityContext, text: string): Promise<void> {
    const parts = text.split(' ');
    const cmd = parts[0];
    const rest = text.substring(cmd.length).trim();
    let out = '';
    try {
      if (cmd === '/ls') {
        out = LocalTools.listSandbox(ctx);
      } else if (cmd === '/read') {
        out = LocalTools.readSandbox(ctx, rest);
      } else if (cmd === '/write') {
        const space = rest.indexOf(' ');
        if (space < 0) {
          out = '用法：/write 文件名 内容。写之前先点允许写这次。';
        } else if (!SensitiveToolGate.hasWriteGrant(this.grantOwner())) {
          this.askWrite = true;
          out = '写文件需要你先点「允许写这次」';
        } else {
          out = LocalTools.writeSandbox(ctx, rest.substring(0, space), rest.substring(space + 1),
            this.grantOwner());
          if (out === '__NEED_WRITE_GRANT__') {
            this.askWrite = true;
            out = '写文件需要你先点「允许写这次」';
          }
        }
      } else if (cmd === '/remember') {
        await memoryStore.load(ctx);
        await memoryStore.appendToday(ctx, rest);
        out = '已写入今日记忆';
      } else if (cmd === '/open') {
        out = LocalTools.openLink(rest);
      } else {
        out = '本机命令：/ls /read /write /remember /open';
      }
    } catch (err) {
      out = `${err}`;
    }
    this.push('system', out);
    await sessionStore.append(ctx, this.currentId, 'system', out);
    this.status = '空闲';
  }

  private historyTurns(): LoopTurn[] {
    const out: LoopTurn[] = [];
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      if (line.role !== 'user' && line.role !== 'assistant') {
        continue;
      }
      const turn = new LoopTurn();
      turn.role = line.role;
      turn.content = line.text;
      turn.imageB64 = line.imageB64;
      turn.imageMime = line.imageMime.length > 0 ? line.imageMime : 'image/jpeg';
      out.push(turn);
    }
    return out;
  }

  private startModel(ctx: common.UIAbilityContext): void {
    this.beginModel(ctx).catch((err: Error) => {
      this.status = err.message;
    });
  }

  private async beginModel(ctx: common.UIAbilityContext): Promise<void> {
    this.stopStream();
    if (this.rounds >= 8) {
      this.status = '工具轮次用完了';
      return;
    }
    this.rounds += 1;
    const queue = providerStore.queue();
    if (this.failIndex >= queue.length) {
      this.status = '供应商都试过了';
      return;
    }
    const slot = queue[this.failIndex];
    const key = providerStore.keyFor(slot.instanceId);
    const client = await OpenAICompatClient.open(providerStore.slotRoot(slot.instanceId), key, slot.model,
      providerStore.slotType(slot.instanceId), providerStore.slotCredential(slot.instanceId),
      slot.instanceId);
    this.assistantOpen = false;
    this.streamBuf = '';
    this.streamDone = false;
    this.clearStreamTick();
    this.stream = client.streamTurn(this.loopTurns, LocalTools.systemPrompt(), this.thinking,
      (delta: string) => {
        this.appendAssistant(delta);
        this.status = '进行中';
      }, (turn: StreamTurn) => {
        this.stream = null;
        this.streamDone = true;
        if (turn.calls.length > 0) {
          this.flushStream();
          this.assistantOpen = false;
          const assistant = new LoopTurn();
          assistant.role = 'assistant';
          assistant.content = turn.text;
          assistant.calls = turn.calls;
          this.loopTurns = this.loopTurns.concat([assistant]);
          if (turn.text.length === 0) {
            this.push('system', themeStore.toolPreview ? `工具 · ${turn.calls[0].name}` : '在用工具');
          }
          this.runTools(ctx, turn.calls);
          return;
        }
        taskStatus.setRunning(false);
        this.persistAssistant(ctx, turn.text, turn.promptTokens, turn.completionTokens);
        if (this.streamBuf.length === 0) {
          this.assistantOpen = false;
          this.status = '空闲';
        }
      }, (message: string) => {
        this.stream = null;
        this.flushStream();
        this.assistantOpen = false;
        const queue = providerStore.queue();
        if (shouldFailover(message) && this.failIndex + 1 < queue.length) {
          this.dropPartialAssistant();
          this.failIndex += 1;
          this.rounds = Math.max(0, this.rounds - 1);
          this.push('system', `换到 ${queue[this.failIndex].model}`);
          this.startModel(ctx);
          return;
        }
        taskStatus.setRunning(false);
        this.push('system', message);
        this.status = message;
      });
  }

  private async runTools(ctx: common.UIAbilityContext, calls: ToolCall[]): Promise<void> {
    this.pendingCalls = [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const result: ToolResult = await LocalTools.run(ctx, call.name, call.args, this.grantOwner());
      if (themeStore.toolPreview) {
        this.push('system', `工具 · ${result.title || call.name}`);
      }
      if (result.needWrite) {
        this.askWrite = true;
        taskStatus.setPendingWrite(true);
        this.pendingCalls = calls.slice(i);
        this.status = '等待写文件';
        return;
      }
      const tool = new LoopTurn();
      tool.role = 'tool';
      tool.toolCallId = call.id.length > 0 ? call.id : `call_${i}`;
      tool.toolName = call.name;
      tool.content = result.text;
      this.loopTurns = this.loopTurns.concat([tool]);
      this.push('system', result.text.length > 240 ? `${result.text.substring(0, 240)}…` : result.text);
      if (this.currentId) {
        sessionStore.append(ctx, this.currentId, 'system', `工具 ${call.name}: ${result.text}`).catch(() => {
          // keep chatting even if archive write fails
        });
      }
    }
    this.startModel(ctx);
  }

  private persistAssistant(ctx: common.UIAbilityContext, output: string, prompt: number = 0,
    completion: number = 0): void {
    usageStore.add(ctx, prompt, completion).catch(() => {
      // keep chatting
    });
    if (!output || !this.currentId) {
      return;
    }
    sessionStore.append(ctx, this.currentId, 'assistant', output).catch((err: Error) => {
      this.status = `${err}`;
    });
  }

  private dropPartialAssistant(): void {
    if (this.lines.length === 0) {
      return;
    }
    const last = this.lines[this.lines.length - 1];
    if (last.role === 'assistant') {
      this.lines = this.lines.slice(0, this.lines.length - 1);
    }
  }

  private push(role: string, text: string, imageB64: string = '', imageMime: string = '',
    imagePath: string = ''): void {
    if (!text && imageB64.length === 0 && imagePath.length === 0) {
      return;
    }
    const line = new LocalChatMessage();
    line.role = role;
    line.text = text;
    line.imageB64 = imageB64;
    line.imageMime = imageMime;
    line.imagePath = imagePath;
    this.lines = this.lines.concat([line]);
    this.followTail();
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

  private async regenerate(): Promise<void> {
    if (this.status === '进行中' || !this.currentId) {
      return;
    }
    let lastUser = -1;
    for (let i = 0; i < this.lines.length; i++) {
      if (this.lines[i].role === 'user') {
        lastUser = i;
      }
    }
    if (lastUser < 0) {
      return;
    }
    this.stopStream();
    this.lines = this.lines.slice(0, lastUser + 1);
    const ctx = getContext(this) as common.UIAbilityContext;
    const session = await sessionStore.get(ctx, this.currentId);
    if (session) {
      session.messages = this.lines.slice();
      await sessionStore.replaceMessages(ctx, session);
    }
    this.rounds = 0;
    this.failIndex = 0;
    this.loopTurns = this.historyTurns();
    this.status = '进行中';
    this.startModel(ctx);
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
        // 原来是 new ArrayBuffer(Math.min(stat.size, 4MB))，超过 4MB 就只读前 4MB，
        // 得到的是一张截断的 JPEG：照样 base64 发给模型、照样写进会话，用户看不出问题。
        // 宁可明说超限，也不要发半张图。
        if (stat.size > 4 * 1024 * 1024) {
          this.status = '这张图超过 4MB，换一张小的';
          return;
        }
        const buf = new ArrayBuffer(stat.size);
        fileIo.readSync(file.fd, buf);
        const helper = new util.Base64Helper();
        this.imageB64 = helper.encodeToStringSync(new Uint8Array(buf));
        this.imageMime = uri.toLowerCase().indexOf('.png') >= 0 ? 'image/png' : 'image/jpeg';
        const ctx = getContext(this) as common.UIAbilityContext;
        this.imagePath = SessionStore.writeImageBytes(ctx, buf, this.imageMime);
        this.imageHint = '已选一张图，发送时带上';
      } finally {
        fileIo.closeSync(file);
      }
    } catch (err) {
      this.status = `${err}`;
    }
  }

  private appendAssistant(delta: string): void {
    if (!delta) {
      return;
    }
    this.streamBuf += delta;
    this.pumpStream();
  }

  private pumpStream(): void {
    if (this.streamTick >= 0) {
      return;
    }
    this.streamTick = setTimeout(() => {
      this.streamTick = -1;
      if (this.streamBuf.length === 0) {
        if (this.streamDone && this.status === '进行中') {
          this.assistantOpen = false;
          this.status = '空闲';
        }
        return;
      }
      const n = this.streamBuf.length > 120 ? 28 : Math.min(10, this.streamBuf.length);
      const take = this.streamBuf.substring(0, n);
      this.streamBuf = this.streamBuf.substring(n);
      this.paintDelta(take);
      if (this.streamBuf.length > 0 || this.streamDone) {
        this.pumpStream();
      }
    }, 16);
  }

  private flushStream(): void {
    this.clearStreamTick();
    if (this.streamBuf.length > 0) {
      this.paintDelta(this.streamBuf);
      this.streamBuf = '';
    }
    this.streamDone = false;
  }

  private clearStreamTick(): void {
    if (this.streamTick >= 0) {
      clearTimeout(this.streamTick);
      this.streamTick = -1;
    }
  }

  private paintDelta(delta: string): void {
    if (!delta) {
      return;
    }
    if (!this.assistantOpen) {
      this.push('assistant', delta);
      this.assistantOpen = true;
      return;
    }
    const copy = this.lines.slice();
    const last = copy[copy.length - 1];
    const next = new LocalChatMessage();
    next.role = last.role;
    next.text = last.text + delta;
    next.imageB64 = last.imageB64;
    next.imageMime = last.imageMime;
    next.imagePath = last.imagePath;
    copy[copy.length - 1] = next;
    this.lines = copy;
    this.followTail();
  }

  private followTail(): void {
    if (this.lines.length === 0) {
      return;
    }
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
