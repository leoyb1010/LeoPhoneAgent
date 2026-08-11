import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

/**
 * grok persists sessions under ~/.grok/sessions/<encoded-cwd>/<id>/. In-app
 * sessions are registered through the normal chat gateway (their native id is
 * self-assigned via --session-id), so indexing on-disk artifacts is only needed
 * to surface sessions the user started in a standalone terminal. That is a
 * v1-optional enhancement; this no-op keeps the contract satisfied without
 * scanning until it's wired.
 */
export class GrokSessionSynchronizer implements IProviderSessionSynchronizer {
  async synchronize(): Promise<number> {
    return 0;
  }

  async synchronizeFile(): Promise<string | null> {
    return null;
  }
}
