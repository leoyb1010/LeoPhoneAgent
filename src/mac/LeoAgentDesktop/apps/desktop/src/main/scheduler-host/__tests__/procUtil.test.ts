import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';

import { capAppend, killProcessTree } from '../proc-util';

describe('capAppend', () => {
  it('caps accumulated output at the given limit', () => {
    expect(capAppend('', 'abc', 5)).toBe('abc');
    expect(capAppend('abc', 'defg', 5)).toBe('abcde');
    expect(capAppend('abcde', 'x', 5)).toBe('abcde');
  });
});

describe('killProcessTree', () => {
  it.runIf(process.platform === 'win32')(
    'win32: taskkill 对不存在的 pid 失败后回落 child.kill(Greptile P1 回归)',
    async () => {
      const kill = vi.fn();
      const fakeChild = { pid: 4_294_000_111, kill } as unknown as ChildProcess;
      // 极大且不存在的 pid:taskkill 必然非 0 退出 → 必须触发 child.kill 兜底
      killProcessTree(4_294_000_111, fakeChild);
      await vi.waitFor(() => expect(kill).toHaveBeenCalledWith('SIGKILL'), { timeout: 10_000 });
    },
    15_000,
  );

  it('falls back to child.kill when pid is missing', () => {
    const kill = vi.fn();
    killProcessTree(undefined, { kill } as unknown as ChildProcess);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });
});
