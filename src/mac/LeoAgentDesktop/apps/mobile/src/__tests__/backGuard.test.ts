import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { goBackGuarded } from '@/utils/backGuard';

type RouterLike = Parameters<typeof goBackGuarded>[0];

function makeRouter(canGoBack: (() => boolean) | undefined) {
  const router = {
    back: vi.fn(),
    replace: vi.fn(),
    canGoBack,
  };
  return router as unknown as RouterLike & { back: ReturnType<typeof vi.fn>; replace: ReturnType<typeof vi.fn> };
}

describe('goBackGuarded', () => {
  it('pops the stack when there is a screen to go back to', () => {
    const router = makeRouter(() => true);
    goBackGuarded(router);
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('replaces to the fallback route when the back stack is empty', () => {
    const router = makeRouter(() => false);
    goBackGuarded(router);
    expect(router.back).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith('/');
  });

  it('treats a missing canGoBack as not-backable instead of dispatching GO_BACK blindly', () => {
    const router = makeRouter(undefined);
    goBackGuarded(router);
    expect(router.back).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith('/');
  });

  it('honors a custom fallback route', () => {
    const router = makeRouter(() => false);
    goBackGuarded(router, '/devices');
    expect(router.replace).toHaveBeenCalledWith('/devices');
  });
});

describe('back-navigation hygiene', () => {
  it('has no bare router.back() outside the guarded helper (screens and components alike)', () => {
    // 扫 app/(Expo Router screens)+ src/(组件层),唯一豁免是 helper 自身。
    const roots = [resolve(process.cwd(), 'app'), resolve(process.cwd(), 'src')];
    const allowed = new Set([resolve(process.cwd(), 'src', 'utils', 'backGuard.ts')]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== '__tests__') walk(full);
          continue;
        }
        if (!/\.(tsx?|jsx?)$/.test(entry) || allowed.has(full)) continue;
        if (readFileSync(full, 'utf8').includes('router.back()')) {
          offenders.push(full);
        }
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});
