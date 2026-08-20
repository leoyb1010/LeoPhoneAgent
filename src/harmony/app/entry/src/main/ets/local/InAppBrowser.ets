import { router } from '@kit.ArkUI';
import { browserStore } from '../store/BrowserStore';
import { SensitiveToolGate } from './SensitiveToolGate';

export class WebLaunch {
  static url: string = '';
}

export class InAppBrowser {
  static open(raw: string, newTab: boolean = false): string {
    const decision = SensitiveToolGate.openUrl(raw);
    if (!decision.allowed) {
      return decision.reason;
    }
    WebLaunch.url = raw.trim();
    if (newTab) {
      browserStore.add(WebLaunch.url);
    } else {
      browserStore.open(WebLaunch.url);
    }
    // 已经在浏览页上就别再压一层。原来每次 open_url 都无条件 pushUrl，
    // 页面栈里会堆好几份 WebPage（每份带一个 Web 引擎），用户得一层层返回才退得出去。
    if (InAppBrowser.onWebPage()) {
      return '';
    }
    // pushUrl 返回 Promise，之前没接。定时任务和「当身体」这两条链路也会调到本方法，
    // 那时通常没有前台页面上下文，push 会失败 —— 不接就是一个未处理拒绝。
    router.pushUrl({ url: 'pages/WebPage' }).catch(() => {
      // 没有 UI 上下文时（定时/远程回合）打不开页面，标签已经记下了，下次进浏览页能看到
    });
    return '';
  }

  private static onWebPage(): boolean {
    try {
      return router.getState().name === 'WebPage';
    } catch (_err) {
      return false;
    }
  }
}
