import { AppNavigation } from '../navigation/AppNavigation';
import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { HarnessClient } from '../net/HarnessClient';
import { gatewayStore } from '../store/GatewayStore';
import { RemoteWorkspaceLaunch } from '../remote/RemoteWorkspaceLaunch';
import { ScreenSessionBridge, ScreenSessionRegistry } from '../remote/ScreenSessionBridge';
import { NavBar } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

@Component
export struct ScreenSessionPage {
  @StorageProp('themeTick') themeTick: number = 0;
  @State ready: boolean = false;
  @State error: string = '';
  @State control: boolean = false;
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: ScreenSessionBridge = new ScreenSessionBridge();
  private active: boolean = false;

  aboutToAppear(): void {
    this.active = true;
    ScreenSessionRegistry.add(this.bridge);
    this.bridge.resume();
    this.bridge.onReply = (payload: string) => {
      if (this.active) {
        this.controller.runJavaScript('window.leoScreenReply(JSON.parse(' + JSON.stringify(payload) + '))').catch(() => {});
      }
    };
    this.bridge.onSuspend = () => {
      this.controller.runJavaScript('window.leoScreenDisconnect?.()').catch(() => {});
      this.control = false;
    };
    this.prepare();
  }

  aboutToDisappear(): void {
    this.active = false;
    ScreenSessionRegistry.remove(this.bridge);
  }

  private async prepare(): Promise<void> {
    try {
      await gatewayStore.ensureLoaded(getContext(this) as common.UIAbilityContext);
      const client = new HarnessClient(gatewayStore.apiRoot, RemoteWorkspaceLaunch.machine, gatewayStore.key);
      const features = await client.capabilities();
      if (!this.active) { return; }
      if (!features.has('screen_session')) { throw new Error('这台 Mac 尚未开放视频看屏'); }
      this.bridge.client = client;
      this.ready = true;
    } catch (err) { this.error = `${err}`; }
  }

  build() {
    NavDestination() {
    Column() {
      NavBar({ title: 'Mac 视频屏幕' })
      Row({ space: 12 }) {
        Text('允许操控 Mac').fontColor(Tokens.text).fontSize(14)
        Toggle({ type: ToggleType.Switch, isOn: this.control }).onChange((value: boolean) => { this.setControl(value); })
      }.padding(10).width('100%')
      if (this.error) { Text(this.error).fontColor(Tokens.warn).fontSize(14).padding(12) }
      if (this.ready) {
        Web({ src: $rawfile('remote_screen.html'), controller: this.controller })
          .javaScriptAccess(true).domStorageAccess(false).databaseAccess(false).fileAccess(false)
          .mediaPlayGestureAccess(false).mixedMode(MixedMode.None)
          .javaScriptProxy({ object: this.bridge, name: 'leoScreen', methodList: ['postMessage'], controller: this.controller })
          .onOverrideUrlLoading((request) => {
            const target = request.getRequestUrl().split(/[?#]/)[0].toLowerCase();
            return target !== 'resource://rawfile/remote_screen.html';
          })
          .onPermissionRequest((event) => { event?.request.deny(); })
          .layoutWeight(1)
      } else { Blank().layoutWeight(1) }
    }.width('100%').height('100%').backgroundColor(Tokens.bg)

    }
    .hideTitleBar(true)
    .onShown(() => { AppNavigation.changed(); })
  }

  private setControl(value: boolean): void {
    if (!value) {
      this.control = false; this.bridge.allowControl = false; this.bridge.close(); this.bridge.resume(); return;
    }
    AlertDialog.show({ title: '允许操控这台 Mac', message: '连接后可以点击、键入和修改 Mac 上的内容。还需 Mac 端已开启手机操控并授予辅助功能权限。',
      confirm: { value: '允许本次操控', action: () => {
        this.bridge.close(); this.bridge.resume(); this.bridge.allowControl = true; this.control = true;
      } }, cancel: () => {} });
  }
}
