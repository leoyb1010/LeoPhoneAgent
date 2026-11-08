import { AppNavigation } from '../navigation/AppNavigation';
import { LocalChatLaunch, LocalChatPane } from '../panes/LocalChatPane';
import { Tokens } from '../theme/Tokens';

@Component
export struct LocalChatPage {
  @StorageProp('themeTick') themeTick: number = 0;
  @State sessionId: string = '';

  aboutToAppear(): void {
    this.sessionId = LocalChatLaunch.sessionId;
  }

  build() {
    NavDestination() {
    Column() {
      LocalChatPane({ sessionId: this.sessionId })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)

    }
    .hideTitleBar(true)
    .onShown(() => { AppNavigation.changed(); })
  }
}
