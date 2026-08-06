/**
 * 睡醒白屏取证埋点(main 侧)—— 2026-07-12/13 连续复现「系统唤醒后窗口白屏/黑屏,
 * renderer 没崩、日志全程沉默」,缺的是两类时间锚点:
 *
 * 1. 系统电源事件(suspend / resume / lock-screen / unlock-screen)——
 *    给所有日志提供「睡了多久、几点醒的」坐标系,renderer 侧 render-watchdog
 *    的定时器漂移要靠它区分「主线程阻塞」还是「系统睡眠」。
 * 2. 窗口失响应(BrowserWindow 'unresponsive' / 'responsive')——
 *    renderer 主线程真卡死时 Chromium 会发这对事件,此前完全没埋点,
 *    白屏时无法判断是「卡死」还是「活着但没出帧」。
 *
 * 只记日志,不改任何行为。两个 install 函数都以注入面暴露依赖,单测不需要 Electron。
 */
import { createLogger } from './logger';

const log = createLogger('power-diagnostics');

/** powerMonitor 注入面(单测用假 emitter)。 */
export interface PowerMonitorLike {
  on(event: 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen', listener: () => void): unknown;
}

/** BrowserWindow 注入面(单测用假 emitter)。 */
export interface ResponsivenessWindowLike {
  on(event: 'unresponsive' | 'responsive', listener: () => void): unknown;
  isDestroyed(): boolean;
}

export interface PowerEventDiagnosticsDeps {
  powerMonitor: PowerMonitorLike;
  now?: () => number;
  logger?: Pick<typeof log, 'info' | 'warn'>;
}

/**
 * 记录系统电源事件。resume 时带上 suspend→resume 的睡眠时长;
 * lock/unlock 只在 macOS / Windows 有事件,Linux 不触发也无害。
 */
export function installPowerEventDiagnostics(deps: PowerEventDiagnosticsDeps): void {
  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger ?? log;
  let suspendedAtMs: number | null = null;

  deps.powerMonitor.on('suspend', () => {
    suspendedAtMs = now();
    logger.info('system suspend');
  });
  deps.powerMonitor.on('resume', () => {
    const sleptMs = suspendedAtMs === null ? null : Math.max(0, now() - suspendedAtMs);
    suspendedAtMs = null;
    logger.info('system resume', sleptMs === null ? {} : { sleptMs });
  });
  deps.powerMonitor.on('lock-screen', () => logger.info('screen locked'));
  deps.powerMonitor.on('unlock-screen', () => logger.info('screen unlocked'));
}

export interface WindowResponsivenessDeps {
  now?: () => number;
  logger?: Pick<typeof log, 'error' | 'info'>;
  /** 日志里区分是哪个窗口(main / right-sidebar 等)。 */
  label: string;
}

/**
 * 记录窗口 renderer 主线程失响应/恢复。unresponsive 记 ERROR(这就是白屏取证
 * 要抓的主嫌疑),responsive 记恢复并附卡死时长。
 */
export function installWindowResponsivenessDiagnostics(
  win: ResponsivenessWindowLike,
  deps: WindowResponsivenessDeps,
): void {
  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger ?? log;
  let unresponsiveSinceMs: number | null = null;

  win.on('unresponsive', () => {
    if (win.isDestroyed()) return;
    unresponsiveSinceMs = now();
    logger.error(`window unresponsive: label=${deps.label}`);
  });
  win.on('responsive', () => {
    if (win.isDestroyed()) return;
    const stuckMs = unresponsiveSinceMs === null ? null : Math.max(0, now() - unresponsiveSinceMs);
    unresponsiveSinceMs = null;
    logger.info(
      `window responsive again: label=${deps.label}` + (stuckMs === null ? '' : ` stuckMs=${stuckMs}`),
    );
  });
}
