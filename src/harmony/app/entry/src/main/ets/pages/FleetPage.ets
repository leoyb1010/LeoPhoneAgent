import { AppNavigation } from '../navigation/AppNavigation';
import { FleetPane } from '../panes/FleetPane';
import { Tokens } from '../theme/Tokens';

@Component
export struct FleetPage {
  @StorageProp('themeTick') themeTick: number = 0;
  build() {
    NavDestination() {
    Column() {
      FleetPane({
        showBack: true,
        onOpen: () => {
          AppNavigation.pushUrl({ url: 'pages/RemoteChatPage' });
        }
      })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)

    }
    .hideTitleBar(true)
    .onShown(() => { AppNavigation.changed(); })
  }
}
