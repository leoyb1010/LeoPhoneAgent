/**
 * schedulerStatusFilterStorage — Automation status 筛选持久化回归(issue #75)
 * ---------------------------------------------------------------------------
 * 覆盖:
 *   1. 无记录 → 默认 'all'
 *   2. persist → load 往返恢复('all' / 'paused')
 *   3. 非法 / 损坏的 localStorage 值 → 静默回退默认,不抛错
 *   4. localStorage 抛错(disabled / quota)→ load 回默认、persist 不抛
 *
 * 项目 vitest env=node,无 window。用 vi.stubGlobal 注入最小 localStorage
 * (与 newMakerDraft.test.ts 同范式)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadStatusFilter,
  persistStatusFilter,
} from '@/features/scheduler/lib/statusFilterStorage';

function createMemStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

let memStorage: ReturnType<typeof createMemStorage>;

beforeEach(() => {
  memStorage = createMemStorage();
  vi.stubGlobal('window', { localStorage: memStorage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('scheduler statusFilter persistence', () => {
  it('falls back to the default "all" when nothing is stored', () => {
    expect(loadStatusFilter()).toBe('all');
  });

  it('restores the last persisted value across reloads', () => {
    persistStatusFilter('all');
    expect(loadStatusFilter()).toBe('all');

    persistStatusFilter('paused');
    expect(loadStatusFilter()).toBe('paused');
  });

  it('ignores invalid stored values and falls back to the default', () => {
    // 'expired' 不是 filter 选项(视觉上折进 active 桶),历史残留 / 手改坏值都回默认
    memStorage.setItem('xdt:scheduler.statusFilter', 'expired');
    expect(loadStatusFilter()).toBe('all');

    memStorage.setItem('xdt:scheduler.statusFilter', 'garbage');
    expect(loadStatusFilter()).toBe('all');
  });

  it('does not throw when localStorage is unavailable', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('storage disabled');
        },
        setItem: () => {
          throw new Error('quota exceeded');
        },
      },
    });

    expect(loadStatusFilter()).toBe('all');
    expect(() => persistStatusFilter('all')).not.toThrow();
  });
});
