// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

// useSplash 模块依赖三个 renderer context,pure helper 测试只需最小 mock。
vi.mock('@/contexts/EnvCheckContext', () => ({ useEnvCheck: () => ({}) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('@/hooks/useUpdateStatus', () => ({ useUpdateStatus: () => ({}) }));

import {
  SPLASH_PHASE_FIXTURE_VALUES,
  readSplashPhaseFixture,
  splashPhaseForFixture,
} from '../useSplash';

/**
 * Splash phase fixture 读取点守护(implementation-plan Step 0 WHAT4 guard 三处
 * 之三):`import.meta.env.DEV && VITE_SPLASH_PHASE_FIXTURE`。VITE_* 会被生产
 * 构建烘焙,DEV 短路是硬约束——PROD 忽略 fixture 是 SC-1 的 production-mode 断言。
 */
describe('readSplashPhaseFixture', () => {
  it('值域冻结为附录 A splash 行 9 值(6 可见态 + 3 失败弹窗)', () => {
    expect([...SPLASH_PHASE_FIXTURE_VALUES]).toEqual([
      'checking_update',
      'updating',
      'update_done',
      'checking',
      'downloading',
      'failed',
      'manifest_failed',
      'download_failed',
      'spawn_failed',
    ]);
  });

  it.each([...SPLASH_PHASE_FIXTURE_VALUES])('DEV + 合法值 %s → 返回该值', (value) => {
    expect(readSplashPhaseFixture({ DEV: true, VITE_SPLASH_PHASE_FIXTURE: value })).toBe(value);
  });

  it('production-mode:DEV=false 时无论 env 值如何一律 null(VITE_* 烘焙防泄漏)', () => {
    for (const value of SPLASH_PHASE_FIXTURE_VALUES) {
      expect(readSplashPhaseFixture({ DEV: false, VITE_SPLASH_PHASE_FIXTURE: value })).toBeNull();
    }
    expect(readSplashPhaseFixture({ VITE_SPLASH_PHASE_FIXTURE: 'updating' })).toBeNull();
  });

  it('非法值/空值/非字符串 → null(只认冻结值域)', () => {
    expect(readSplashPhaseFixture({ DEV: true, VITE_SPLASH_PHASE_FIXTURE: 'waking' })).toBeNull();
    expect(readSplashPhaseFixture({ DEV: true, VITE_SPLASH_PHASE_FIXTURE: '' })).toBeNull();
    expect(readSplashPhaseFixture({ DEV: true, VITE_SPLASH_PHASE_FIXTURE: 42 })).toBeNull();
    expect(readSplashPhaseFixture({ DEV: true })).toBeNull();
  });

  it('fixture 值 → 真实 SplashPhase 映射(failed → splash_failed,其余加前缀)', () => {
    expect(splashPhaseForFixture('checking_update')).toBe('splash_checking_update');
    expect(splashPhaseForFixture('failed')).toBe('splash_failed');
    expect(splashPhaseForFixture('spawn_failed')).toBe('splash_spawn_failed');
    expect(splashPhaseForFixture('downloading')).toBe('splash_downloading');
  });
});
