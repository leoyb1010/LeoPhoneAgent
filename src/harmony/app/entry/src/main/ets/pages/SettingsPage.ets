import { AppNavigation } from '../navigation/AppNavigation';
import { SettingsPane } from '../panes/SettingsPane';
import { Tokens } from '../theme/Tokens';

@Component
export struct SettingsPage {
  @StorageProp('themeTick') tick: number = 0;

  build() {
    NavDestination() {
    Column() {
      SettingsPane({ showBack: true })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)

    }
    .hideTitleBar(true)
    .onShown(() => { AppNavigation.changed(); })
  }
}
