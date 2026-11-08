import { fileIo } from '@kit.CoreFileKit';
import { atomicWriteText } from './AtomicFile';
import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { resourceManager } from '@kit.LocalizationKit';
import { window } from '@kit.ArkUI';
import { Tokens } from '../theme/Tokens';
import { taskStatus } from './TaskStatus';

export class ThemeStore {
  mode: string = 'system';
  launch: string = 'auto';
  returnSend: boolean = false;
  keepAwake: boolean = false;
  toolPreview: boolean = true;
  expandThinking: boolean = true;
  showTitle: boolean = true;
  homeCards: boolean = true;
  systemDark: boolean = false;
  private loaded: boolean = false;
  private win: window.Window | null = null;
  private application: common.ApplicationContext | null = null;
  private nativeMode: ConfigurationConstant.ColorMode | null = null;
  nativeError: string = '';

  isDark(): boolean {
    if (this.mode === 'light') {
      return false;
    }
    if (this.mode === 'dark') {
      return true;
    }
    return this.systemDark;
  }

  /** Called only by the successful HomePage loadContent callback, on the UIAbility main thread. */
  attachWindow(win: window.Window, application: common.ApplicationContext): void {
    if (this.application !== application) this.nativeMode = null;
    this.win = win; this.application = application;
    this.apply();
  }

  detachWindow(win: window.Window | null): void {
    if (this.win !== win) return;
    this.win = null; this.application = null; this.nativeMode = null;
  }

  apply(): void {
    if (this.mode === 'system') this.readSystemMode();
    // Static semantic colors must be committed before setColorMode triggers configuration/UI refresh.
    this.publishPalette();
    this.applyNativeMode();
  }

  onConfigurationUpdate(colorMode: ConfigurationConstant.ColorMode | undefined): void {
    // Fixed-mode callbacks describe the override, not the actual system preference.
    if (this.mode === 'system' && (colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT ||
      colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK)) {
      this.systemDark = colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    }
    this.publishPalette();
    // Never call setColorMode from its own configuration callback (including synchronous delivery).
  }

  private readSystemMode(): void {
    try {
      const mode = resourceManager.getSystemResourceManager().getConfigurationSync().colorMode;
      if (mode === resourceManager.ColorMode.DARK || mode === resourceManager.ColorMode.LIGHT) {
        this.systemDark = mode === resourceManager.ColorMode.DARK;
      }
    } catch (_error) {
      // Keep the last real system value. Releasing the override still reconciles it from the native callback.
    }
  }

  private publishPalette(): void {
    Tokens.apply(this.isDark());
    this.applyBars();
    // Monotonic revisions notify even when two preference changes share the same millisecond.
    AppStorage.setOrCreate('themeTick', (AppStorage.get<number>('themeTick') ?? 0) + 1);
  }

  private applyNativeMode(): void {
    const application = this.application;
    if (!this.win || !application) return;
    const target = this.mode === 'light' ? ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT :
      this.mode === 'dark' ? ConfigurationConstant.ColorMode.COLOR_MODE_DARK : ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET;
    if (this.nativeMode === target) { this.nativeError = ''; return; }
    const previous = this.nativeMode;
    // Record before entering the SDK so a synchronous configuration callback cannot reconfigure recursively.
    this.nativeMode = target; this.nativeError = '';
    try { application.setColorMode(target); }
    catch (_error) {
      this.nativeMode = previous;
      this.nativeError = '外观已保存，系统颜色模式未应用，请重试';
    }
  }

  async load(context: common.Context): Promise<void> {
    if (this.loaded) {
      this.apply();
      return;
    }
    const path = context.filesDir + '/appearance.json';
    if (fileIo.accessSync(path)) {
      try {
        const obj = JSON.parse(fileIo.readTextSync(path)) as Record<string, Object>;
        const mode = `${obj['mode'] ?? 'system'}`;
        if (mode === 'light' || mode === 'dark' || mode === 'system') {
          this.mode = mode;
        }
        const launch = `${obj['launch'] ?? 'auto'}`;
        if (launch === 'auto' || launch === 'last' || launch === 'new' || launch === 'home') {
          this.launch = launch;
        }
        this.returnSend = obj['returnSend'] === true;
        this.keepAwake = obj['keepAwake'] === true;
        this.toolPreview = obj['toolPreview'] !== false;
        this.expandThinking = obj['expandThinking'] !== false;
        this.showTitle = obj['showTitle'] !== false;
        this.homeCards = obj['homeCards'] !== false;
      } catch (_err) {
        this.mode = 'system';
      }
    }
    this.loaded = true;
    taskStatus.setCardsEnabled(this.homeCards);
    this.apply();
  }

  async save(context: common.Context): Promise<void> {
    const body = new ThemeFile();
    body.mode = this.mode;
    body.launch = this.launch;
    body.returnSend = this.returnSend;
    body.keepAwake = this.keepAwake;
    body.toolPreview = this.toolPreview;
    body.expandThinking = this.expandThinking;
    body.showTitle = this.showTitle;
    body.homeCards = this.homeCards;
    const path = context.filesDir + '/appearance.json';
    atomicWriteText(path, JSON.stringify(body));
    taskStatus.setCardsEnabled(this.homeCards);
    this.apply();
  }

  async reload(context: common.Context): Promise<void> {
    this.loaded = false;
    await this.load(context);
  }

  private applyBars(): void {
    if (!this.win) {
      return;
    }
    const props: window.SystemBarProperties = {
      statusBarColor: Tokens.bg,
      statusBarContentColor: Tokens.text,
      navigationBarColor: Tokens.bg,
      navigationBarContentColor: Tokens.text
    };
    try {
      this.win.setWindowSystemBarProperties(props).catch(() => {});
      this.win.setWindowKeepScreenOn(this.keepAwake).catch(() => {});
    } catch (_error) { /* A closing window is updated when the replacement attaches. */ }
  }
}

class ThemeFile {
  mode: string = 'system';
  launch: string = 'auto';
  returnSend: boolean = false;
  keepAwake: boolean = false;
  toolPreview: boolean = true;
  expandThinking: boolean = true;
  showTitle: boolean = true;
  homeCards: boolean = true;
}

export const themeStore: ThemeStore = new ThemeStore();
