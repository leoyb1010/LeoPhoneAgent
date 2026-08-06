import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { stripBackgroundAudioMode } = require('../../plugins/with-foreground-only-audio.js') as {
  stripBackgroundAudioMode: (infoPlist: Record<string, unknown>) => Record<string, unknown>;
};

describe('with-foreground-only-audio config plugin', () => {
  it('removes the audio background mode and its empty key', () => {
    const infoPlist = stripBackgroundAudioMode({ UIBackgroundModes: ['audio'] });

    expect(infoPlist).not.toHaveProperty('UIBackgroundModes');
  });

  it('preserves unrelated background modes while removing every audio entry', () => {
    const infoPlist = stripBackgroundAudioMode({
      UIBackgroundModes: ['remote-notification', 'audio', 'fetch', 'audio'],
      ExistingKey: true,
    });

    expect(infoPlist).toEqual({
      UIBackgroundModes: ['remote-notification', 'fetch'],
      ExistingKey: true,
    });
  });

  it('leaves a plist without a background-mode array untouched', () => {
    const infoPlist = { ExistingKey: true };

    expect(stripBackgroundAudioMode(infoPlist)).toBe(infoPlist);
    expect(infoPlist).toEqual({ ExistingKey: true });
  });
});
