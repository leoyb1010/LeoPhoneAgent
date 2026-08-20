import { router } from '@kit.ArkUI';
import { FleetPane } from '../panes/FleetPane';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct FleetPage {
  build() {
    Column() {
      FleetPane({
        onOpen: () => {
          router.pushUrl({ url: 'pages/RemoteChatPage' });
        }
      })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}
