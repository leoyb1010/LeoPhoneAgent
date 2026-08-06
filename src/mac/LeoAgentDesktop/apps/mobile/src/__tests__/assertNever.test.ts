import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertNever, logUnhandledRenderItem } from '@/session/assertNever';

describe('assertNever / logUnhandledRenderItem', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('assertNever throws (for non-render paths)', () => {
    // 用 unknown 桥接绕过 never 的编译期约束,仅测运行时行为。
    expect(() => assertNever('boom' as unknown as never)).toThrow();
  });

  it('logUnhandledRenderItem logs an error and returns without throwing (render-path safe)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let returned: unknown = 'sentinel';
    expect(() => {
      returned = logUnhandledRenderItem('unknown-item' as unknown as never);
    }).not.toThrow();
    expect(returned).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toContain('unhandled render item');
  });
});
