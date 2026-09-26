import { AbilityConstant, Configuration, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { ChatRuns } from '../local/ChatRun';
import { ScheduleRunner } from '../local/ScheduleRunner';
import { startBody } from '../net/OutboundClient';
import { gatewayStore } from '../store/GatewayStore';
import { scheduleStore } from '../store/ScheduleStore';
import { sessionStore } from '../store/SessionStore';
import { themeStore } from '../store/ThemeStore';
import { UiState } from '../store/UiState';
import { PushRegistrar } from '../push/PushRegistrar';

export default class EntryAbility extends UIAbility {
  private tick: number = -1;
  private workerSeen: number = 0;

  onCreate(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    themeStore.systemDark = this.context.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    themeStore.load(this.context).catch(() => {
      themeStore.apply();
    });
    gatewayStore.ensureLoaded(this.context).catch(() => {
      // first launch has empty prefs
    });
    startBody(this.context);
    PushRegistrar.bind(this.context).catch(() => {
      // Push Kit 没配 AGC 时页面会写出原因
    });
    try {
      webview.WebviewController.initializeWebEngine();
    } catch (_err) {
      // Web 引擎初始化失败时登录页会自己报错，不再丢给系统浏览器
    }
    this.takeOpen(want);
  }

  /** 点通知回来:打开那个对话。 */
  onNewWant(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    this.takeOpen(want);
  }

  onForeground(): void {
    ChatRuns.onForeground();
    UiState.beat(this.context, true);
    this.catchUp().catch(() => {
      // 读档失败时照旧用内存里的
    }).finally(() => {
      this.armSchedule();
    });
  }

  onBackground(): void {
    this.clearSchedule();
    UiState.beat(this.context, false);
    // 还有一轮在跑(或定时任务在跑)就申请一段后台宽限,说完了发通知。
    ChatRuns.onBackground(ScheduleRunner.busy);
  }

  onConfigurationUpdate(newConfig: Configuration): void {
    themeStore.systemDark = newConfig.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    themeStore.apply();
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.getMainWindow().then((win: window.Window) => {
      themeStore.attachWindow(win);
    });
    windowStage.loadContent('pages/HomePage', (err) => {
      if (err.code) {
        console.error(`load HomePage failed ${JSON.stringify(err)}`);
      }
    });
  }

  private takeOpen(want: Want): void {
    const params = want.parameters;
    const id = params ? `${params['openSession'] ?? ''}` : '';
    if (id.length > 0) {
      AppStorage.setOrCreate('openSession', id);
    }
  }

  /** 后台进程跑过定时任务(改过档案)就重新读,免得内存里的旧副本把它写的盖掉;顺手登记后台唤起。 */
  private async catchUp(): Promise<void> {
    const at = UiState.workerAt(this.context);
    if (at > this.workerSeen) {
      this.workerSeen = at;
      await sessionStore.reload(this.context);
      await scheduleStore.reload(this.context);
    }
    await scheduleStore.load(this.context);
    await ScheduleRunner.syncWork(this.context);
  }

  private armSchedule(): void {
    this.clearSchedule();
    this.fireDue();
    this.tick = setInterval(() => {
      UiState.beat(this.context, true);
      this.fireDue();
    }, 30000);
  }

  private clearSchedule(): void {
    if (this.tick >= 0) {
      clearInterval(this.tick);
      this.tick = -1;
    }
  }

  private fireDue(): void {
    ScheduleRunner.runDue(this.context, !ChatRuns.foreground).catch(() => {
      // 下一个 30 秒再试
    });
  }
}
