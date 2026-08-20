import { webview } from '@kit.ArkWeb';
import { router } from '@kit.ArkUI';
import { browserStore, BrowserTab } from '../store/BrowserStore';
import { WebLaunch } from '../local/InAppBrowser';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct WebPage {
  @StorageProp('themeTick') tick: number = 0;
  @State url: string = '';
  @State tabs: BrowserTab[] = [];
  @State activeId: string = '';
  private controller: webview.WebviewController = new webview.WebviewController();
  private attached: boolean = false;

  aboutToAppear(): void {
    if (browserStore.tabs.length === 0 && WebLaunch.url.length > 0) {
      browserStore.open(WebLaunch.url);
    }
    this.sync();
  }

  aboutToDisappear(): void {
    this.attached = false;
  }

  build() {
    Column() {
      Row() {
        Text('关闭')
          .fontSize(14)
          .fontColor(Tokens.accent)
          .onClick(() => {
            router.back();
          })
        Text('后退')
          .fontSize(13)
          .fontColor(Tokens.link)
          .margin({ left: 14 })
          .onClick(() => {
            try {
              if (this.controller.accessBackward()) {
                this.controller.backward();
              }
            } catch (_err) {
              // history optional
            }
          })
        Text('前进')
          .fontSize(13)
          .fontColor(Tokens.link)
          .margin({ left: 12 })
          .onClick(() => {
            try {
              if (this.controller.accessForward()) {
                this.controller.forward();
              }
            } catch (_err) {
              // history optional
            }
          })
        Blank()
        Text('+ 标签')
          .fontSize(13)
          .fontColor(Tokens.link)
          .onClick(() => {
            if (this.url.length > 0) {
              browserStore.add(this.url);
              this.sync();
            }
          })
      }
      .width('100%')
      .padding({ left: 20, right: 20, top: 10, bottom: 8 })
      Row() {
        ForEach(this.tabs, (tab: BrowserTab) => {
          Text(tab.title.length > 12 ? tab.title.substring(0, 12) : tab.title)
            .fontSize(12)
            .fontColor(tab.id === this.activeId ? Tokens.text : Tokens.muted)
            .padding({ left: 8, right: 8, top: 6, bottom: 6 })
            .backgroundColor(tab.id === this.activeId ? Tokens.surface : Tokens.bg)
            .borderRadius(8)
            .onClick(() => {
              browserStore.activeId = tab.id;
              this.sync();
            })
        }, (tab: BrowserTab) => tab.id)
      }
      .width('100%')
      .padding({ left: 12, right: 12, bottom: 8 })
      if (this.url.length > 0) {
        Web({ src: this.url, controller: this.controller })
          .width('100%')
          .layoutWeight(1)
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .onControllerAttached(() => {
            this.attached = true;
          })
          .onPageEnd(() => {
            try {
              const title = this.controller.getTitle();
              const current = browserStore.active();
              if (current && title) {
                current.title = title;
                this.sync();
              }
            } catch (_err) {
              // title optional
            }
          })
      } else {
        Column() {
          Text('没有可打开的链接')
            .fontSize(16)
            .fontColor(Tokens.text)
        }
        .layoutWeight(1)
        .width('100%')
        .justifyContent(FlexAlign.Center)
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }

  private sync(): void {
    this.tabs = browserStore.tabs.slice();
    this.activeId = browserStore.activeId;
    const current = browserStore.active();
    const next = current ? current.url : '';
    const changed = next !== this.url;
    this.url = next;
    if (next.length === 0) {
      // 没有标签时 Web 组件整个被销毁，controller 也就不再有效
      this.attached = false;
    }
    // Web 的 src 只在组件创建时生效一次，之后改 this.url 页面不会重新加载。
    // 原来切标签只改了 this.url，显示的还是第一个标签的页面 ——
    // browser_use switch_tab 汇报「已切到 X」但用户看到的是旧页。
    // controller 已经挂上时必须显式 loadUrl。
    if (changed && next.length > 0 && this.attached) {
      try {
        this.controller.loadUrl(next);
      } catch (_err) {
        // controller 还没就绪时，Web 会用 src 首次加载
      }
    }
  }
}
