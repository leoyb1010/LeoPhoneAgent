import { AbilityConstant, Configuration, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { LocalAgentEngine } from '../local/LocalAgentEngine';
import { LocalTools } from '../local/LocalTools';
import { startBody } from '../net/OutboundClient';
import { gatewayStore } from '../store/GatewayStore';
import { ScheduleStore, ScheduleTask, scheduleStore } from '../store/ScheduleStore';
import { sessionStore } from '../store/SessionStore';
import { themeStore } from '../store/ThemeStore';
import { PushRegistrar } from '../push/PushRegistrar';

export default class EntryAbility extends UIAbility {
  private tick: number = -1;

  onCreate(_want: Want, _launchParam: AbilityConstant.LaunchParam): void {
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
  }

  onForeground(): void {
    this.armSchedule();
  }

  onBackground(): void {
    this.clearSchedule();
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

  private armSchedule(): void {
    this.clearSchedule();
    this.fireDue();
    this.tick = setInterval(() => {
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
    if (scheduleStore.running) {
      return;
    }
    scheduleStore.load(this.context).then(() => {
      const rows = scheduleStore.dueNow();
      if (rows.length === 0) {
        return;
      }
      scheduleStore.running = true;
      this.markThenRun(rows, 0);
    }).catch(() => {
      // first launch has empty schedule
    });
  }

  private markThenRun(rows: ScheduleTask[], index: number): void {
    if (index >= rows.length) {
      scheduleStore.running = false;
      return;
    }
    const row = rows[index];
    this.runOne(row).then(() => {
      this.markThenRun(rows, index + 1);
    }).catch(() => {
      this.markThenRun(rows, index + 1);
    });
  }

  private async runOne(row: ScheduleTask): Promise<void> {
    await LocalTools.hydrate(this.context);
    await sessionStore.ensureLoaded(this.context);
    let sessionId = row.sessionId;
    if (!sessionId) {
      const session = await sessionStore.create(this.context, ScheduleStore.sessionTitle(row.title));
      sessionId = session.id;
    }
    await sessionStore.append(this.context, sessionId, 'user', row.prompt);
    const mine = LocalAgentEngine.bump('schedule');
    await new Promise<void>((resolve: Function) => {
      // 看门狗：这个 Promise 只有 onDone/onError 才 resolve，
      // 而 LocalAgentEngine 在「这一轮已经被换代」的几个分支里是直接 return、一个回调都不调的。
      // 一旦命中，markThenRun 就再也不往下走，scheduleStore.running 永远是 true，
      // 之后所有定时任务全部静默不执行，直到 App 重启。
      // 这里只负责把调度器的锁放开，不取消正在跑的回合 ——
      // 回合真跑完时 onDone/onError 照样会写会话和 lastResult（resolve 本身是幂等的）。
      const guard = setTimeout(() => {
        resolve();
      }, 10 * 60 * 1000);
      const settle = (): void => {
        clearTimeout(guard);
        resolve();
      };
      LocalAgentEngine.run(this.context, 'schedule', mine, row.prompt, '', () => {
        // schedule has no live pane
      }, (output: string) => {
        sessionStore.append(this.context, sessionId, 'assistant', output).catch(() => {
          // keep next task moving
        });
        scheduleStore.record(this.context, row.rowId, sessionId, output, '').catch(() => {
          // keep next task moving
        });
        settle();
      }, (message: string) => {
        sessionStore.append(this.context, sessionId, 'system', message).catch(() => {
          // keep next task moving
        });
        scheduleStore.record(this.context, row.rowId, sessionId, '', message).catch(() => {
          // keep next task moving
        });
        settle();
      });
    });
  }
}
