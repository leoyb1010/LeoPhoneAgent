import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { gatewayStore } from '../store/GatewayStore';

export default class EntryAbility extends UIAbility {
  onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    gatewayStore.load(this.context).catch(() => {
      // first launch has empty prefs
    });
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/HomePage', (err) => {
      if (err.code) {
        console.error(`load HomePage failed ${JSON.stringify(err)}`);
      }
    });
  }
}
