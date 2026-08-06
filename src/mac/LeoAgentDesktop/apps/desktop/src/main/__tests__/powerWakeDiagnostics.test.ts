/**
 * powerWakeDiagnostics.test.ts
 * ---------------------------------------------------------------------------
 * 睡醒白屏取证埋点(电源事件 + 窗口失响应)的行为测试。
 * 通过注入假 emitter / 假时钟驱动,不依赖 Electron。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  installPowerEventDiagnostics,
  installWindowResponsivenessDiagnostics,
  type PowerMonitorLike,
  type ResponsivenessWindowLike,
} from '../powerWakeDiagnostics';

function createEmitter<E extends string>() {
  const listeners = new Map<E, Array<() => void>>();
  return {
    on(event: E, listener: () => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return this;
    },
    emit(event: E) {
      for (const cb of listeners.get(event) ?? []) cb();
    },
  };
}

describe('installPowerEventDiagnostics', () => {
  it('suspend→resume 记录睡眠时长', () => {
    const pm = createEmitter<'suspend' | 'resume' | 'lock-screen' | 'unlock-screen'>();
    const logger = { info: vi.fn(), warn: vi.fn() };
    let nowMs = 1_000;
    installPowerEventDiagnostics({
      powerMonitor: pm as PowerMonitorLike,
      now: () => nowMs,
      logger,
    });

    pm.emit('suspend');
    nowMs += 90_000;
    pm.emit('resume');

    expect(logger.info).toHaveBeenCalledWith('system suspend');
    expect(logger.info).toHaveBeenCalledWith('system resume', { sleptMs: 90_000 });
  });

  it('没有配对 suspend 的 resume 不携带 sleptMs;再次 resume 不复用旧起点', () => {
    const pm = createEmitter<'suspend' | 'resume' | 'lock-screen' | 'unlock-screen'>();
    const logger = { info: vi.fn(), warn: vi.fn() };
    let nowMs = 0;
    installPowerEventDiagnostics({
      powerMonitor: pm as PowerMonitorLike,
      now: () => nowMs,
      logger,
    });

    pm.emit('resume');
    expect(logger.info).toHaveBeenCalledWith('system resume', {});

    pm.emit('suspend');
    nowMs += 10_000;
    pm.emit('resume');
    logger.info.mockClear();
    nowMs += 5_000;
    pm.emit('resume'); // 第二次 resume,suspend 起点已消费
    expect(logger.info).toHaveBeenCalledWith('system resume', {});
  });

  it('lock/unlock 事件各记一条', () => {
    const pm = createEmitter<'suspend' | 'resume' | 'lock-screen' | 'unlock-screen'>();
    const logger = { info: vi.fn(), warn: vi.fn() };
    installPowerEventDiagnostics({ powerMonitor: pm as PowerMonitorLike, logger });

    pm.emit('lock-screen');
    pm.emit('unlock-screen');
    expect(logger.info).toHaveBeenCalledWith('screen locked');
    expect(logger.info).toHaveBeenCalledWith('screen unlocked');
  });
});

describe('installWindowResponsivenessDiagnostics', () => {
  function createWindow() {
    const emitter = createEmitter<'unresponsive' | 'responsive'>();
    let destroyed = false;
    const win: ResponsivenessWindowLike & { emit: (e: 'unresponsive' | 'responsive') => void; destroy: () => void } = {
      on: (event, listener) => emitter.on(event, listener),
      isDestroyed: () => destroyed,
      emit: (e) => emitter.emit(e),
      destroy: () => {
        destroyed = true;
      },
    };
    return win;
  }

  it('unresponsive 记 ERROR,responsive 记恢复并带卡死时长', () => {
    const win = createWindow();
    const logger = { error: vi.fn(), info: vi.fn() };
    let nowMs = 0;
    installWindowResponsivenessDiagnostics(win, { label: 'main', now: () => nowMs, logger });

    win.emit('unresponsive');
    nowMs += 7_500;
    win.emit('responsive');

    expect(logger.error).toHaveBeenCalledWith('window unresponsive: label=main');
    expect(logger.info).toHaveBeenCalledWith('window responsive again: label=main stuckMs=7500');
  });

  it('没有配对 unresponsive 的 responsive 不带 stuckMs', () => {
    const win = createWindow();
    const logger = { error: vi.fn(), info: vi.fn() };
    installWindowResponsivenessDiagnostics(win, { label: 'main', logger });

    win.emit('responsive');
    expect(logger.info).toHaveBeenCalledWith('window responsive again: label=main');
  });

  it('窗口已销毁时不再记日志', () => {
    const win = createWindow();
    const logger = { error: vi.fn(), info: vi.fn() };
    installWindowResponsivenessDiagnostics(win, { label: 'main', logger });

    win.destroy();
    win.emit('unresponsive');
    win.emit('responsive');
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
