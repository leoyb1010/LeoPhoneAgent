import { describe, expect, it, vi } from 'vitest';

import { MAKER_PUSH } from '../../maker-ipc/channels.js';
import {
  broadcastOrcaWorkerChangedToWindows,
  type OrcaWorkerBroadcastWindow,
} from '../orcaWorkerBroadcast.js';

function makeWindow(
  send: (channel: string, payload: unknown) => void,
  destroyed = false,
): OrcaWorkerBroadcastWindow {
  return {
    isDestroyed: () => destroyed,
    webContents: { send },
  };
}

describe('orca worker broadcast', () => {
  it('sends ORCA_WORKER_CHANGED to live windows and keeps broadcasting after per-window failures', () => {
    const firstSend = vi.fn(() => {
      throw new Error('window gone');
    });
    const destroyedSend = vi.fn();
    const secondSend = vi.fn();

    broadcastOrcaWorkerChangedToWindows([
      makeWindow(firstSend),
      makeWindow(destroyedSend, true),
      makeWindow(secondSend),
    ], 'lead-session-1');

    expect(firstSend).toHaveBeenCalledWith(MAKER_PUSH.ORCA_WORKER_CHANGED, {
      leadSessionId: 'lead-session-1',
    });
    expect(destroyedSend).not.toHaveBeenCalled();
    expect(secondSend).toHaveBeenCalledWith(MAKER_PUSH.ORCA_WORKER_CHANGED, {
      leadSessionId: 'lead-session-1',
    });
  });
});
