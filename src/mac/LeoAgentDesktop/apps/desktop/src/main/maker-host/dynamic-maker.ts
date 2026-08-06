import type { Maker } from '@cindy/maker-core';

/**
 * Stable Maker facade for process-lifetime IPC registrations.
 *
 * IPC handlers are installed once, while the concrete Maker is replaced when
 * the active data owner changes. Every property read and method call therefore
 * resolves the current instance instead of retaining the startup owner.
 */
export function createDynamicMaker(resolve: () => Maker): Maker {
  const methodCache = new Map<PropertyKey, (...args: unknown[]) => unknown>();

  return new Proxy({} as Maker, {
    get(_target, property) {
      const current = resolve();
      const value = Reflect.get(current, property, current) as unknown;
      if (typeof value !== 'function') return value;

      let delegated = methodCache.get(property);
      if (!delegated) {
        delegated = (...args: unknown[]) => {
          const live = resolve();
          const method = Reflect.get(live, property, live) as unknown;
          if (typeof method !== 'function') {
            throw new TypeError(`Maker property ${String(property)} is no longer callable`);
          }
          return Reflect.apply(method, live, args);
        };
        methodCache.set(property, delegated);
      }
      return delegated;
    },
    set(_target, property, value) {
      const current = resolve();
      return Reflect.set(current, property, value, current);
    },
  });
}
