import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => ''),
  },
}));

vi.mock('../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

import { __testing } from '../maker-host/collaboration-settings-store';

describe('collaboration settings store', () => {
  it('defaults background worker auto-release to disabled', () => {
    expect(__testing.normalize(undefined).workerIdleReleaseMinutes).toBe(0);
    expect(__testing.normalize({}).workerIdleReleaseMinutes).toBe(0);
  });

  it('preserves zero as the disabled value', () => {
    expect(__testing.normalize({ workerIdleReleaseMinutes: 0 }).workerIdleReleaseMinutes)
      .toBe(0);
  });
});
