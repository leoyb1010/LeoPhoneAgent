/**
 * LeoBot HarmonyOS visual tokens. Quiet warm surfaces, graphite text and teal actions
 * share the same hierarchy across chat, archives and settings.
 */
export class Tokens {
  /** Explicit UI dependency bridge. Read a @StorageProp revision in each paint expression;
   * the semantic palette remains unchanged and no component identity or view state is reset. */
  static reactive<T>(_revision: number, value: T): T { return value; }

  static readonly transparent: string = '#00000000';
  /** Always over dark media, independent of app appearance. */
  static readonly onMedia: string = '#FFFFFF';
  static readonly mediaScrim: string = '#B8202A25';
  static floatingShadow: string = '#26000000';
  static get avatarColors(): string[] { return [Tokens.accent, Tokens.link, Tokens.online, Tokens.warn, Tokens.secondary]; }

  static bg: string = '#FBFCFA';
  /** 设置这类分组页面的底色。 */
  static grouped: string = '#F0F3EF';
  /** 分组页上的白卡片。 */
  static card: string = '#FFFFFF';
  static surface: string = '#EDF2EE';
  static surface2: string = '#E0E8E2';
  static raised: string = '#F5F8F3';
  static separator: string = '#D7E0D8';
  static input: string = '#FFFFFF';
  static accent: string = '#267B6D';
  static accentSoft: string = '#16267B6D';
  static fab: string = '#267B6D';
  static heroA: string = '#3F8070';
  static heroB: string = '#8BC6AE';
  static text: string = '#202A25';
  static secondary: string = '#5D6C63';
  static muted: string = '#6F7C72';
  static online: string = '#287E58';
  static warn: string = '#A56A22';
  static danger: string = '#BB453E';
  static link: string = '#246C64';
  static userBubble: string = '#E2ECE6';
  static userText: string = '#24392D';
  static send: string = '#245F50';
  static sendGlyph: string = '#FFFFFF';
  static sendOff: string = '#CBD6CD';
  static toolCapsule: string = '#EDF2EE';
  static codeBg: string = '#17241D';
  static codeText: string = '#C7E2CA';
  static inlineCodeBg: string = '#EAF0E8';
  static inlineCodeText: string = '#5D623D';
  static errorTint: string = '#12BB453E';
  static warnTint: string = '#14A56A22';
  static composer: string = '#FFFFFF';
  /** 卡片里的芯片、圆按钮(深色时卡片本身就是 #1C1C1E,要再亮一档才看得见)。 */
  static chip: string = '#F0F4ED';
  static composerShadow: string = '#0A193A28';
  static sparkleA: string = '#497D65';
  static sparkleB: string = '#8AAA89';
  static dividerColor: string = '#B8C7BC';
  static dark: boolean = false;
  /** 宽度到这个值(vp)就左右分栏:平板横竖、折叠屏展开都算(原来还要求横着拿,展开的折叠屏近似正方形、略高,一直是被拉宽的手机版)。 */
  static readonly wideBreak: number = 600;
  /** 再宽(大平板、三折叠全展开):列表固定宽,正文限宽。 */
  static readonly largeBreak: number = 840;
  static readonly listWide: number = 320;
  /** 正文最宽多少,再宽读着累(iOS 可读宽度 800pt)。 */
  static readonly readable: number = 720;
  static readonly tallBreak: number = 480;
  static readonly pagePad: number = 16;
  static readonly rowHPad: number = 16;
  static readonly rowVPad: number = 12;
  static readonly rowGap: number = 12;
  static readonly iconCircle: number = 44;
  static readonly iconGlyph: number = 20;
  static readonly settingsIcon: number = 30;
  static readonly settingsGlyph: number = 17;
  static readonly fabSize: number = 56;
  static readonly fabGlyph: number = 24;
  static readonly fabPadH: number = 16;
  static readonly fabPadV: number = 20;
  static readonly searchField: number = 44;
  static readonly title: number = 20;
  static readonly largeTitle: number = 30;
  static readonly welcome: number = 27;
  static readonly body: number = 16;
  static readonly rowTitle: number = 16;
  static readonly rowSub: number = 14;
  static readonly section: number = 14;
  static readonly time: number = 13;
  static readonly caption: number = 12;
  static readonly pill: number = 12;
  static readonly topBar: number = 52;
  static readonly chatBar: number = 56;
  static readonly composerH: number = 44;
  static readonly sendSize: number = 44;
  static readonly bubbleMax: string = '80%';
  static readonly bubbleRadius: number = 18;
  static readonly cardRadius: number = 16;
  static readonly groupRadius: number = 14;
  static readonly settingsRadius: number = 12;
  static readonly composerRadius: number = 20;
  static readonly capsule: number = 36;
  static readonly hero: number = 72;
  static readonly heroRadius: number = 23;
  static readonly heroGlyph: number = 32;
  static readonly heroCompact: number = 52;
  static readonly stepIcon: number = 38;
  static readonly stepRadius: number = 12;
  static readonly stepGreen: string = '#25B96F';
  static readonly chatMark: string = '#34C759';
  static readonly pinBadge: number = 14;
  static readonly divider: number = 1;
  static readonly hairline: number = 0.5;

  static apply(dark: boolean): void {
    Tokens.dark = dark;
    Tokens.floatingShadow = dark ? '#60000000' : '#26000000';
    if (dark) {
      Tokens.bg = '#101612';
      Tokens.grouped = '#101612';
      Tokens.card = '#19221D';
      Tokens.surface = '#202C24';
      Tokens.surface2 = '#2A382E';
      Tokens.raised = '#26342B';
      Tokens.separator = '#35443A';
      Tokens.input = '#19221D';
      Tokens.accent = '#84D3BD';
      Tokens.accentSoft = '#2484D3BD';
      Tokens.fab = '#336B5B';
      Tokens.text = '#F2F6EF';
      Tokens.secondary = '#B1BFB3';
      Tokens.muted = '#98AA9B';
      Tokens.online = '#82D0A0';
      Tokens.warn = '#E7B775';
      Tokens.danger = '#FF9A8C';
      Tokens.link = '#8CD5C4';
      Tokens.userBubble = '#2A4033';
      Tokens.userText = '#E4F1E7';
      Tokens.send = '#A5DBBF';
      Tokens.sendGlyph = '#10271B';
      Tokens.sendOff = '#35483B';
      Tokens.toolCapsule = '#23352A';
      Tokens.codeBg = '#121D16';
      Tokens.codeText = '#CAE7D0';
      Tokens.inlineCodeBg = '#2A3C2E';
      Tokens.inlineCodeText = '#C9D6A1';
      Tokens.errorTint = '#26FF9A8C';
      Tokens.warnTint = '#26E7B775';
      Tokens.composer = '#19251E';
      Tokens.chip = '#26372A';
      Tokens.composerShadow = '#18000000';
      Tokens.sparkleA = '#A5C9AF';
      Tokens.sparkleB = '#789C7C';
      Tokens.dividerColor = '#526B59';
      return;
    }
    Tokens.bg = '#FBFCFA';
    Tokens.grouped = '#F0F3EF';
    Tokens.card = '#FFFFFF';
    Tokens.surface = '#EDF2EE';
    Tokens.surface2 = '#E0E8E2';
    Tokens.raised = '#F5F8F3';
    Tokens.separator = '#D7E0D8';
    Tokens.input = '#FFFFFF';
    Tokens.accent = '#267B6D';
    Tokens.accentSoft = '#16267B6D';
    Tokens.fab = '#267B6D';
    Tokens.text = '#202A25';
    Tokens.secondary = '#5D6C63';
    Tokens.muted = '#6F7C72';
    Tokens.online = '#287E58';
    Tokens.warn = '#A56A22';
    Tokens.danger = '#BB453E';
    Tokens.link = '#246C64';
    Tokens.userBubble = '#E2ECE6';
    Tokens.userText = '#24392D';
    Tokens.send = '#245F50';
    Tokens.sendGlyph = '#FFFFFF';
    Tokens.sendOff = '#CBD6CD';
    Tokens.toolCapsule = '#EDF2EE';
    Tokens.codeBg = '#17241D';
    Tokens.codeText = '#C7E2CA';
    Tokens.inlineCodeBg = '#EAF0E8';
    Tokens.inlineCodeText = '#5D623D';
    Tokens.errorTint = '#12BB453E';
    Tokens.warnTint = '#14A56A22';
    Tokens.composer = '#FFFFFF';
    Tokens.chip = '#F0F4ED';
    Tokens.composerShadow = '#0A193A28';
    Tokens.sparkleA = '#497D65';
    Tokens.sparkleB = '#8AAA89';
    Tokens.dividerColor = '#B8C7BC';
  }
}
