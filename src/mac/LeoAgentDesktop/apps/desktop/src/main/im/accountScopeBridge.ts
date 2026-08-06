import type { IMHost } from '@cindy/im';

type AccountScope = NonNullable<IMHost['accountScope']>;

let delegate: AccountScope | null = null;

/**
 * Break the host/index construction cycle while keeping @cindy/im account-agnostic.
 * `host.ts` exposes this stable adapter; `index.ts` installs the authenticated
 * lifecycle implementation once its serialized connection coordinator exists.
 */
export function configureImAccountScope(next: AccountScope): void {
  delegate = next;
}

/** Host adapter passed to @cindy/im; calls always resolve against the latest delegate. */
export const imHostAccountScope: AccountScope = {
  capture(): unknown | null {
    return delegate?.capture() ?? null;
  },

  isCurrent(token: unknown): boolean {
    return delegate?.isCurrent(token) ?? false;
  },

  run<T>(token: unknown, operation: () => Promise<T>): Promise<T> {
    if (!delegate) {
      return Promise.reject(new Error('[IM_NOT_READY] IM account scope is not configured'));
    }
    return delegate.run(token, operation);
  },
};
