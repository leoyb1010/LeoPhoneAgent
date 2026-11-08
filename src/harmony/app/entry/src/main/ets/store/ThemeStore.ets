import { fileIo } from '@kit.CoreFileKit';
import { atomicWriteText } from './AtomicFile';
import { common } from '@kit.AbilityKit';
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

  isDark(): boolean {
    if (this.mode === 'light') {
      return false;
    }
    if (this.mode === 'dark') {
      return true;
    }
    return this.systemDark;
  }

  attachWindow(win: window.Window): void {
    this.win = win;
    this.applyBars();
  }

  detachWindow(win: window.Window | null): void { if (this.win === win) this.win = null; }

  apply(): void {
    Tokens.apply(this.isDark());
    this.applyBars();
    AppStorage.setOrCreate('themeTick', Date.now());
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
