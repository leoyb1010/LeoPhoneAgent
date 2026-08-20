import { ChatLaunch } from '../net/HarnessClient';
import { ChatPane } from '../panes/ChatPane';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct RemoteChatPage {
  @State machine: string = '';

  aboutToAppear(): void {
    this.machine = ChatLaunch.machine;
  }

  build() {
    Column() {
      ChatPane({ machine: this.machine })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}
