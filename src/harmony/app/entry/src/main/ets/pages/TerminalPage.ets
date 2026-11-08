import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { util } from '@kit.ArkTS';
import { LinuxRuntime } from '../local/LinuxRuntime';
import { LinuxTerminalBridge } from '../local/LinuxTerminalBridge';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct TerminalPage {
  @StorageProp('linuxStage') @Watch('installStageChanged') installStage: string = '';
  @State message: string = '正在初始化本机 Alpine Linux…';
  @State pid: number = 0;
  @State running: boolean = false;
  private owner: string = 'terminal:' + util.generateRandomUUID(false);
  private timer: number = -1;
  private closed: boolean = false;
  private pendingOutput: string = '';
  private rendering: boolean = false;
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: LinuxTerminalBridge = new LinuxTerminalBridge();

  installStageChanged(): void { if (!this.running && !this.closed) this.message = this.installStage; }
  aboutToAppear(): void {
    this.closed = false;
    this.bridge.onReady = () => this.flushOutput();
    this.bridge.onInput = (text: string) => this.send(text);
    this.bridge.onResize = (columns: number, rows: number) => {
      if (this.running) LinuxRuntime.resize(this.owner, this.pid, columns, rows);
    };
    this.bridge.onError = (message: string) => this.message = message;
    this.start();
  }
  aboutToDisappear(): void {
    this.closed = true;
    this.bridge.enabled = false;
    clearInterval(this.timer);
    if (this.running) LinuxRuntime.detach(this.owner, this.pid).catch(() => {});
    this.pendingOutput = '';
  }
  private async start(): Promise<void> {
    if (this.running) return;
    try {
      await LinuxRuntime.initialize(getContext(this) as common.UIAbilityContext);
      if (this.closed) return;
      this.pid = LinuxRuntime.start(this.owner, '', true);
      this.running = true;
      this.bridge.enabled = true;
      this.message = 'Alpine 3.22.2 · ARM64 · ' + LinuxRuntime.networkStatus;
      clearInterval(this.timer);
      this.timer = setInterval(() => this.poll(), 80);
    } catch (error) { this.message = `${error}`; }
  }
  private poll(): void {
    if (!this.running) return;
    try {
      const output = LinuxRuntime.poll(this.owner, this.pid);
      this.pendingOutput += output.text;
      if (this.pendingOutput.length > 200000) {
        this.pendingOutput = this.pendingOutput.slice(-200000);
        this.message = '终端尚未显示的内容过多，较早输出已截断';
      }
      this.flushOutput();
      if (output.truncated) this.message = '输出过多，部分内容已截断';
      if (output.exited) {
        this.running = false;
        this.bridge.enabled = false;
        clearInterval(this.timer);
        this.message = '会话已退出，退出码 ' + output.exitCode;
      }
    } catch (error) {
      this.message = `${error}`;
      this.running = false;
      this.bridge.enabled = false;
      clearInterval(this.timer);
      LinuxRuntime.detach(this.owner, this.pid).catch(() => {});
    }
  }
  private flushOutput(): void {
    if (!this.bridge.ready || this.closed || this.rendering || !this.pendingOutput) return;
    const output = this.pendingOutput;
    this.pendingOutput = '';
    this.rendering = true;
    this.controller.runJavaScript('window.leoTerminalOutput(' + JSON.stringify(output) + ')')
      .catch(() => { if (!this.closed) this.message = '终端显示暂时不可用，请重新打开页面'; })
      .finally(() => {
        this.rendering = false;
        if (!this.closed && this.pendingOutput) this.flushOutput();
      });
  }
  private send(text: string): void {
    if (!this.running || this.closed) return;
    try { LinuxRuntime.write(this.owner, this.pid, text); }
    catch (error) { this.message = `${error}`; }
  }
  build() {
    Column({ space: 8 }) {
      Row({ space: 12 }) {
        Button('返回').onClick(() => router.back())
        Text('本机 Linux 终端').fontSize(21).fontColor(Tokens.text).layoutWeight(1)
        if (this.running) { Button('停止').onClick(() => LinuxRuntime.stop(this.owner, this.pid)) }
        else { Button('重新打开').onClick(() => this.start()) }
      }.padding(12).width('100%')
      Text(this.message).fontSize(12).fontColor(Tokens.secondary).width('100%').padding({ left: 12, right: 12 })
      Web({ src: $rawfile('terminal/terminal.html'), controller: this.controller })
        .javaScriptAccess(true).domStorageAccess(false).databaseAccess(false).fileAccess(false)
        .javaScriptProxy({ object: this.bridge, name: 'leoTerminal', methodList: ['postMessage'], controller: this.controller })
        .onOverrideUrlLoading((request) => request.getRequestUrl() !== 'resource://rawfile/terminal/terminal.html')
        .onPermissionRequest((event) => event?.request.deny())
        .layoutWeight(1).width('100%')
      Row({ space: 8 }) {
        Button('Ctrl-C').enabled(this.running).onClick(() => this.send('\u0003'))
        Button('Tab').enabled(this.running).onClick(() => this.send('\t'))
        Button('↑').enabled(this.running).onClick(() => this.send('\u001b[A'))
        Button('↓').enabled(this.running).onClick(() => this.send('\u001b[B'))
      }.width('100%').padding({ left: 12, right: 12, bottom: 12 })
    }.width('100%').height('100%').backgroundColor(Tokens.bg)
  }
}
