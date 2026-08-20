import { SettingsPane } from '../panes/SettingsPane';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct SettingsPage {
  @StorageProp('themeTick') tick: number = 0;

  build() {
    Column() {
      SettingsPane()
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Tokens.bg)
  }
}
