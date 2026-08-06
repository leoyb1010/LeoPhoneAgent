/**
 * createIM — aggregate factory.
 * ---------------------------------------------------------------------------
 * Combines a list of BaseIM channels into a single IM facade with init /
 * dispose / registerIpc. Per-channel errors are isolated via Promise.allSettled
 * so one failing channel does not block the others.
 */

import type { BaseIM } from './BaseIM.js';

export interface IM {
  init(): Promise<void>;
  dispose(): Promise<void>;
  registerIpc(): void;
}

export function createIM(channels: BaseIM[]): IM {
  return {
    init: async () => {
      await Promise.allSettled(channels.map((c) => c.init()));
    },
    dispose: async () => {
      await Promise.allSettled(channels.map((c) => c.dispose()));
    },
    registerIpc: () => {
      for (const c of channels) c.registerIpc();
    },
  };
}
