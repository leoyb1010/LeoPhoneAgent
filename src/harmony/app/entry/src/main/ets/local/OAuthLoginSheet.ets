import { webview } from '@kit.ArkWeb';
import { pasteboard } from '@kit.BasicServicesKit';
import { BrowserOAuth } from './BrowserOAuth';
import { Tokens } from '../theme/Tokens';

@Component
export struct OAuthLoginSheet {
  @Prop authUrl: string = '';
  @Prop userCode: string = '';
  @Prop providerType: string = '';
  @State localError: string = '';
  @State failed: boolean = false;
  @State loaded: boolean = false;
  @State copied: boolean = false;
  onCapture: (url: string) => boolean = (_url: string) => {
    return false;
  };
  onClose: () => void = () => {
  };
  onError: (text: string) => void = (_text: string) => {
  };
  private web: webview.WebviewController = new webview.WebviewController();
  private loadGen: number = 0;

  aboutToAppear(): void {
    this.armWatch();
  }

  aboutToDisappear(): void {
    this.loadGen += 1;
  }

  build() {
    Column() {
      Row() {
        Text('关闭登录')
          .fontSize(14)
          .fontColor(Tokens.accent)
          .onClick(() => {
            this.onClose();
          })
        Blank()
        Text(this.copied ? '已复制' : '复制链接')
          .fontSize(13)
          .fontColor(Tokens.link)
          .onClick(() => {
            this.copy();
          })
        if (this.userCode.length > 0) {
          Text(this.userCode)
            .fontSize(16)
            .fontWeight(FontWeight.Bold)
            .fontColor(Tokens.link)
            .margin({ left: 12 })
        }
      }
      .width('100%')
      .padding({ left: 20, right: 20, top: 10, bottom: 8 })
      if (this.userCode.length > 0) {
        Text(`在网页输入 ${this.userCode}`)
          .fontSize(13)
          .fontColor(Tokens.muted)
          .width('100%')
          .padding({ left: 20, right: 20, bottom: 8 })
      }
      if (!this.failed && BrowserOAuth.networkHint(this.providerType).length > 0) {
        Text(BrowserOAuth.networkHint(this.providerType))
          .fontSize(13)
          .fontColor(Tokens.warn)
          .width('100%')
          .padding({ left: 20, right: 20, bottom: 8 })
      }
      if (this.failed) {
        this.failPanel()
      } else {
        Web({ src: this.authUrl.length > 0 ? this.authUrl : 'about:blank', controller: this.web })
          .width('100%')
          .layoutWeight(1)
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .multiWindowAccess(false)
          .onControllerAttached(() => {
            if (this.authUrl.length > 0) {
              this.web.loadUrl(this.authUrl);
            }
          })
          .onWindowNew((event) => {
            event.handler.setWebController(this.web);
          })
          .onLoadIntercept((event) => {
            return this.onCapture(`${event.data.getRequestUrl()}`);
          })
          .onPageEnd((event) => {
            const url = `${event.url ?? ''}`;
            if (url.length > 0 && url !== 'about:blank') {
              this.loaded = true;
            }
          })
          .onErrorReceive((event) => {
            this.noteError(`${event.error.getErrorCode()}`, event.error.getErrorInfo());
          })
          .onHttpErrorReceive((event) => {
            this.noteError(`HTTP ${event.response.getResponseCode()}`, `${event.response.getResponseCode()}`);
          })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }

  @Builder
  failPanel() {
    Column() {
      Text(this.localError)
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .fontColor(Tokens.text)
        .width('100%')
      if (BrowserOAuth.networkHint(this.providerType).length > 0) {
        Text(BrowserOAuth.networkHint(this.providerType))
          .fontSize(13)
          .fontColor(Tokens.muted)
          .width('100%')
          .margin({ top: 10 })
      }
      Button(this.copied ? '已复制登录链接' : '复制登录链接')
        .width('100%')
        .height(44)
        .margin({ top: 20 })
        .backgroundColor(Tokens.accent)
        .fontColor('#FFFFFF')
        .onClick(() => {
          this.copy();
        })
      Text(this.failHint())
        .fontSize(12)
        .fontColor(Tokens.muted)
        .width('100%')
        .margin({ top: 12 })
    }
    .width('100%')
    .layoutWeight(1)
    .alignItems(HorizontalAlign.Start)
    .padding({ left: 20, right: 20, top: 8, bottom: 24 })
  }

  private armWatch(): void {
    const mine = this.loadGen + 1;
    this.loadGen = mine;
    setTimeout(() => {
      if (mine !== this.loadGen || this.loaded || this.failed) {
        return;
      }
      this.noteError('timeout', '页面一直没打开');
    }, this.providerType === 'kimiCode' ? 20000 : 8000);
  }

  private failHint(): string {
    if (this.providerType === 'kimiCode') {
      return '不跳系统浏览器。把上面的设备码记下来，复制链接换浏览器打开再输入。';
    }
    return '不跳系统浏览器。OpenAI 地区拦截时，系统浏览器也是同一页 403。';
  }

  private noteError(code: string, info: string): void {
    if (this.failed && this.localError.length > 0 && !BrowserOAuth.regionBlocked(code, info)) {
      return;
    }
    const text = BrowserOAuth.webErrorCopy(code, info, this.providerType);
    this.localError = text;
    this.failed = true;
    this.onError(text);
  }

  private copy(): void {
    const board = pasteboard.getSystemPasteboard();
    const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, this.authUrl);
    board.setData(data);
    this.copied = true;
  }
}
