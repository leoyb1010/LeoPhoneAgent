import { LocalChatLaunch, LocalChatPane } from '../panes/LocalChatPane';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct LocalChatPage {
  @State sessionId: string = '';

  aboutToAppear(): void {
    this.sessionId = LocalChatLaunch.sessionId;
  }

  build() {
    Column() {
      LocalChatPane({ sessionId: this.sessionId })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}
