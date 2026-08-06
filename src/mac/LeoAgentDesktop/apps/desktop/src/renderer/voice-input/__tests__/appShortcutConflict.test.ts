import { describe, expect, it } from 'vitest';

import type { AppShortcutCombo } from '../../../shared/appShortcuts';
import type { VoiceInputShortcut } from '../shortcut';
import {
  findVoiceInputAppShortcutConflict,
  voiceInputShortcutToAppShortcutCombo,
} from '../appShortcutConflict';

function combo(code: string, mods: Partial<AppShortcutCombo> = {}): AppShortcutCombo {
  return {
    code,
    meta: Boolean(mods.meta),
    ctrl: Boolean(mods.ctrl),
    alt: Boolean(mods.alt),
    shift: Boolean(mods.shift),
  };
}

function voiceShortcut(
  code: string,
  mods: Partial<VoiceInputShortcut['modifiers']> = {},
): VoiceInputShortcut {
  return {
    trigger: 'keyboard',
    code,
    key: code,
    modifiers: {
      meta: Boolean(mods.meta),
      ctrl: Boolean(mods.ctrl),
      alt: Boolean(mods.alt),
      shift: Boolean(mods.shift),
      fn: Boolean(mods.fn),
    },
  };
}

describe('voice input app shortcut conflicts', () => {
  it('converts regular keyboard voice shortcuts to app shortcut combos', () => {
    expect(voiceInputShortcutToAppShortcutCombo(voiceShortcut('KeyB', { meta: true }))).toEqual(
      expect.objectContaining({ code: 'KeyB', meta: true, ctrl: false, alt: false, shift: false }),
    );
  });

  it('does not convert modifier-only or Fn-backed shortcuts', () => {
    expect(voiceInputShortcutToAppShortcutCombo({
      trigger: 'modifier',
      code: 'MetaLeft',
      key: 'MetaLeft',
      modifiers: { meta: false, ctrl: false, alt: false, shift: false, fn: false },
    })).toBeNull();
    expect(voiceInputShortcutToAppShortcutCombo(voiceShortcut('Digit1', { fn: true }))).toBeNull();
  });

  it('finds an app shortcut that already owns the same combo', () => {
    expect(
      findVoiceInputAppShortcutConflict(voiceShortcut('KeyB', { meta: true }), [
        { id: 'new-maker', combos: [combo('KeyN', { meta: true })] },
        { id: 'toggle-sidebar', combos: [combo('KeyB', { meta: true })] },
      ]),
    ).toBe('toggle-sidebar');
  });
});
