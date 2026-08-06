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

import { __testing } from '../window-behavior-settings-store';

describe('window behavior settings store', () => {
  it('asks for a Windows close behavior until the user chooses one', () => {
    expect(__testing.normalize(undefined).windowsCloseBehavior).toBeNull();
    expect(__testing.normalize({}).windowsCloseBehavior).toBeNull();
  });

  it.each(['tray', 'quit'] as const)('accepts the %s Windows close behavior', (behavior) => {
    expect(__testing.normalize({ windowsCloseBehavior: behavior }).windowsCloseBehavior).toBe(
      behavior,
    );
  });

  it('rejects invalid persisted close behavior', () => {
    expect(__testing.normalize({ windowsCloseBehavior: 'hide' }).windowsCloseBehavior).toBeNull();
  });
});
