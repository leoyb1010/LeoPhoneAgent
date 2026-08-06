/**
 * loggerDevTerminal.test.ts — dev 终端镜像的限长规则(2026-07 卡顿修复)。
 *
 * 背景:dev 日志级别默认 trace,agent 高并发时超长 debug 行(曾经的每请求
 * 64KiB body dump)会整行镜像到终端,Windows console 消费极慢导致内核缓冲
 * 持续堆积、util.format/拷贝压满 main event loop。修复后镜像行截断到 8KiB
 * (文件日志不受影响),write() 背压时暂停镜像等 drain。
 * 背压状态机依赖真实 stream 的 drain 事件,不适合脱离进程单测;这里锁死
 * 可纯化的截断规则。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '0.0.0-test',
    getPath: () => '',
  },
}));

import { truncateDevTerminalLine } from '../logger';

describe('truncateDevTerminalLine(dev 终端镜像限长)', () => {
  it('短行原样透传(不加任何后缀)', () => {
    const line = '[ts] [INFO ] [scope] hello\n';
    expect(truncateDevTerminalLine(line)).toBe(line);
  });

  it('恰好 8KiB 的行不截断', () => {
    const line = 'x'.repeat(8 * 1024);
    expect(truncateDevTerminalLine(line)).toBe(line);
  });

  it('超长行截断到 8KiB 并追加提示(含原始长度),行尾保住换行', () => {
    const line = 'y'.repeat(64 * 1024) + '\n';
    const out = truncateDevTerminalLine(line);
    expect(out.length).toBeLessThan(9 * 1024);
    expect(out.startsWith('y'.repeat(8 * 1024))).toBe(true);
    expect(out).toContain(`terminal mirror truncated, ${line.length} chars`);
    expect(out.endsWith('\n')).toBe(true);
  });
});
