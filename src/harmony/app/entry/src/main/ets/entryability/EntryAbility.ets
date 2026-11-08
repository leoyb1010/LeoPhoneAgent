import { AbilityConstant, Configuration, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window, KeyboardAvoidMode } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { ChatRuns } from '../local/ChatRun';
import { ScheduleRunner } from '../local/ScheduleRunner';
import { startBody } from '../net/OutboundClient';
import { gatewayStore } from '../store/GatewayStore';
import { scheduleStore } from '../store/ScheduleStore';
import { SessionStore, sessionStore } from '../store/SessionStore';
import { themeStore } from '../store/ThemeStore';
import { UiState } from '../store/UiState';
import { MailWatch } from '../mail/MailWatch';
import { BackupStore } from '../backup/BackupStore';
import { McpOAuth } from '../local/McpOAuth';
import { McpStdio } from '../local/McpStdio';
import { SSHRuntime } from '../local/SSHRuntime';
import { ChatViewState } from '../local/ChatViewState';
import { FormStatus } from '../form/FormStatus';
import { ReplicaSync } from '../sync/ReplicaSync';
import { MotionPolicy } from '../theme/MotionPolicy';
import { ScreenSessionRegistry } from '../remote/ScreenSessionBridge';
import { BrowserAutomation } from '../local/BrowserAutomation';
import { BrainAPI } from '../brain/BrainAPI';
import { RecordingController } from '../recording/RecordingController';
import { ShareInbox } from '../shareextension/ShareInbox';
import { PushRegistrar } from '../push/PushRegistrar';

export default class EntryAbility extends UIAbility {
  private tick: number = -1;
  private workerSeen: number = 0;
  private recoveryFailed: boolean = false;
  private startupComplete: boolean = false;
  private startup: Promise<void> = Promise.resolve();
  private destroyed: boolean = false;
  private foregroundGeneration: number = 0;
  private wantsForeground: boolean = false;
  private windowGeneration: number = 0;
  private mainWindow: window.Window | null = null;
  private windowListener: ((size: window.Size) => void) | null = null;
  private keyboardListener: ((height: number) => void) | null = null;

  onCreate(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    this.startup = this.initialize(want).catch(() => {
      this.recoveryFailed = true;
      AppStorage.setOrCreate('startupRecoveryError', '本机资料初始化未完成，数据已保留，请检查后重新打开');
    });
  }

  private async initialize(want: Want): Promise<void> {
    try {
      await BackupStore.recoverAsync(this.context);
    } catch (_err) {
      this.recoveryFailed = true;
      AppStorage.setOrCreate('startupRecoveryError', '备份恢复未完成，数据已保留，请检查备份记录');
      return;
    }
    if (this.destroyed) return;
    this.startupComplete = true;
    FormStatus.attach(this.context);
    MotionPolicy.start();
    themeStore.systemDark = this.context.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    themeStore.load(this.context).catch(() => {
      themeStore.apply();
    });
    gatewayStore.ensureLoaded(this.context).catch(() => {
      // first launch has empty prefs
    });
    startBody(this.context);
    try { PushRegistrar.attach(this); } catch (_err) {}
    PushRegistrar.bind(this.context).catch(() => {
      // Push Kit 没配 AGC 时页面会写出原因
    });
    try {
      webview.WebviewController.initializeWebEngine();
    } catch (_err) {
      // Web 引擎初始化失败时登录页会自己报错，不再丢给系统浏览器
    }
    this.takeOpen(want);
    this.takeShared(want);
  }

  /** 点通知回来:打开那个对话。 */
  onNewWant(want: Want, _launchParam: AbilityConstant.LaunchParam): void {
    this.startup.then(() => {
      if (this.recoveryFailed || this.destroyed) return;
      this.takeOpen(want);
      this.takeShared(want);
    });
  }

  onDestroy(): void {
    this.destroyed = true;
    themeStore.detachWindow(this.mainWindow);
    this.wantsForeground = false;
    this.foregroundGeneration++;
    this.windowGeneration++;
    if (this.mainWindow && this.windowListener) {
      try { this.mainWindow.off('windowSizeChange', this.windowListener); } catch (_error) {}
    }
    if (this.mainWindow && this.keyboardListener) {
      try { this.mainWindow.off('keyboardHeightChange', this.keyboardListener); } catch (_error) {}
    }
    MotionPolicy.stop();
    McpStdio.closeAll();

    ReplicaSync.stopForeground();
    this.clearSchedule();
    if (this.startupComplete) PushRegistrar.detach();
  }

  private takeShared(want: Want): void {
    ShareInbox.receive(this.context, want).catch(() => {
      AppStorage.setOrCreate('shareError', '分享内容读取失败，请重新分享');
    });
    const params = want.parameters;
    let data: Record<string, Object> = {};
    try {
      const raw = params ? params['data'] : undefined;
      data = typeof raw === 'string' ? JSON.parse(raw) as Record<string, Object> : (raw ?? {}) as Record<string, Object>;
    } catch (_err) { return; }
    const session = `${data['session_id'] ?? params?.['session_id'] ?? ''}`;
    const machine = `${data['machine'] ?? params?.['machine'] ?? ''}`;
    if (/^[A-Za-z0-9_-]{1,128}$/.test(session) && /^[A-Za-z0-9_.-]{1,80}$/.test(machine)) {
      AppStorage.setOrCreate('pushRemoteSession', session);
      AppStorage.setOrCreate('pushRemoteMachine', machine);
      AppStorage.setOrCreate('pushRemoteTick', (AppStorage.get<number>('pushRemoteTick') ?? 0) + 1);
    }
  }

  onForeground(): void {
    this.wantsForeground = true;
    const generation = ++this.foregroundGeneration;
    this.startup.then(() => {
      if (this.destroyed || this.recoveryFailed || !this.wantsForeground || generation !== this.foregroundGeneration) return;
      this.enterForeground();
    });
  }

  private enterForeground(): void {
    AppStorage.setOrCreate('platformForeground', true);
    BrowserAutomation.setForeground(true);
    ScreenSessionRegistry.resume();
    ChatRuns.onForeground();
    ReplicaSync.startForeground(this.context);
    UiState.beat(this.context, true);
    this.catchUp().catch(() => {
      // 读档失败时照旧用内存里的
    }).finally(() => {
      if (this.wantsForeground && !this.destroyed) this.armSchedule();
    });
  }

  onBackground(): void {
    this.wantsForeground = false;
    this.foregroundGeneration++;
    if (!this.startupComplete || this.recoveryFailed) return;
    AppStorage.setOrCreate('platformForeground', false);
    BrowserAutomation.setForeground(false);
    ChatViewState.flush();
    ReplicaSync.stopForeground();
    ScreenSessionRegistry.suspend();
    SSHRuntime.stopAll();

    BrainAPI.invalidate();
    AppStorage.setOrCreate('brainLockedAt', Date.now());
    if (RecordingController.current && !RecordingController.backgroundAvailable) {
      RecordingController.stop(this.context).catch(() => {});
    }
    this.clearSchedule();
    UiState.beat(this.context, false);
    // 还有一轮在跑(或定时任务在跑)就申请一段后台宽限,说完了发通知。
    ChatRuns.onBackground(ScheduleRunner.busy);
  }

  onConfigurationUpdate(newConfig: Configuration): void {
    if (!this.startupComplete) return;
    themeStore.onConfigurationUpdate(newConfig.colorMode);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    const generation = ++this.windowGeneration;
    windowStage.loadContent('pages/StartupPage');
    this.startup.then(() => {
      if (this.destroyed || generation !== this.windowGeneration) return;
      this.loadWindow(windowStage, generation);
    });
  }

  onWindowStageDestroy(): void {
    this.windowGeneration++;
    themeStore.detachWindow(this.mainWindow);
    if (this.mainWindow && this.windowListener) {
      try { this.mainWindow.off('windowSizeChange', this.windowListener); } catch (_error) {}
    }
    if (this.mainWindow && this.keyboardListener) {
      try { this.mainWindow.off('keyboardHeightChange', this.keyboardListener); } catch (_error) {}
    }
    this.mainWindow = null;
    this.windowListener = null;
    this.keyboardListener = null;
    AppStorage.setOrCreate('keyboardVisible', false);
  }

  private loadWindow(windowStage: window.WindowStage, generation: number): void {
    if (this.recoveryFailed) {
      windowStage.loadContent('pages/RecoveryPage');
      return;
    }
    windowStage.loadContent('pages/HomePage', (err) => {
      if (this.destroyed || generation !== this.windowGeneration) return;
      if (err.code) {
        console.error(`load HomePage failed ${JSON.stringify(err)}`);
      }
      else {
        windowStage.getMainWindow().then((win: window.Window) => {
          if (this.destroyed || generation !== this.windowGeneration) return;
          win.getUIContext().setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE);
          this.mainWindow = win;
          themeStore.attachWindow(win, this.context.getApplicationContext());
          this.windowListener = (_size: window.Size) => { this.publishWindowFrame(win); };
          win.on('windowSizeChange', this.windowListener);
          this.keyboardListener = (height: number) => { AppStorage.setOrCreate('keyboardVisible', height > 0); };
          win.on('keyboardHeightChange', this.keyboardListener);
          this.publishWindowFrame(win);
        }).catch(() => {});
      }
    });
  }

  private publishWindowFrame(win: window.Window): void {
    try {
      const frame = win.getWindowProperties().windowRect;
      AppStorage.setOrCreate('windowFrameHeight', win.getUIContext().px2vp(frame.height));
      AppStorage.setOrCreate('windowFrameWidth', win.getUIContext().px2vp(frame.width));
    } catch (_error) {}
  }

  private takeOpen(want: Want): void {
    if (want.uri && McpOAuth.capture(want.uri)) return;
    const pages: Record<string, string> = {
      'brain': 'pages/BrainSpacePage', 'files': 'pages/WorkspacePage', 'terminal': 'pages/TerminalPage',
      'recordings': 'pages/RecordingsPage', 'settings': 'pages/SettingsPage', 'collections': 'pages/CollectionsPage',
      'sync': 'pages/SyncPage', 'approval': 'pages/ApprovalPage', 'ssh': 'pages/SSHTerminalPage'
    };
    const link = /^(?:leobot|lobe|leophoneagent):\/\/([a-z]+)(?:\/([^?#]*))?\/?$/.exec(want.uri ?? '');
    const page = link ? (pages[link[1]] ?? '') : '';
    const requested = String(want.parameters?.['openPage'] ?? page);
    if (Object.keys(pages).some((key: string) => pages[key] === requested)) {
      AppStorage.setOrCreate('requestedPage', requested);
    }
    if (link && link[1] === 'chat') {
      try {
        const session = decodeURIComponent(link[2] ?? '');
        if (SessionStore.validId(session)) AppStorage.setOrCreate('requestedSession', session);
      } catch (_error) {}
    }

    const params = want.parameters;
    const id = params ? `${params['openSession'] ?? ''}` : '';
    if (SessionStore.validId(id)) {
      AppStorage.setOrCreate('requestedSession', id);
    }
  }

  /** 后台进程跑过定时任务(改过档案)就重新读,免得内存里的旧副本把它写的盖掉;顺手登记后台唤起。 */
  private async catchUp(): Promise<void> {
    MailWatch.check(this.context).catch(() => {});
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
