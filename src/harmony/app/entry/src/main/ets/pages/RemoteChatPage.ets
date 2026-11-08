import { AppNavigation } from '../navigation/AppNavigation';
import { ChatLaunch } from '../net/HarnessClient';
import { ChatPane } from '../panes/ChatPane';
import { Tokens } from '../theme/Tokens';

@Component
export struct RemoteChatPage {
  @StorageProp('themeTick') themeTick: number = 0;
  @State machine: string = '';

  aboutToAppear(): void {
    this.machine = ChatLaunch.machine;
  }

  build() {
    NavDestination() {
    Column() {
      ChatPane({ machine: this.machine, showBack: true })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)

    }
    .hideTitleBar(true)
    .onShown(() => { AppNavigation.changed(); })
  }
}
