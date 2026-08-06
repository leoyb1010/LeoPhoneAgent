import {
  appShortcutCombosEqual,
  type AppShortcutCombo,
  type AppShortcutId,
} from '../../shared/appShortcuts';
import type { VoiceInputShortcut } from './shortcut';

/** App shortcut id plus its currently effective key combinations. */
export interface AppShortcutComboEntry {
  id: AppShortcutId;
  combos: ReadonlyArray<AppShortcutCombo>;
}

/**
 * Convert a keyboard-based voice input shortcut into the same normalized combo
 * shape used by app shortcuts. Modifier-only and Fn-backed shortcuts are handled
 * by separate native paths, so they cannot collide with app shortcut listeners.
 */
export function voiceInputShortcutToAppShortcutCombo(
  shortcut: VoiceInputShortcut,
): AppShortcutCombo | null {
  if (shortcut.trigger === 'modifier') return null;
  if (shortcut.modifiers.fn) return null;
  return {
    code: shortcut.code,
    key: shortcut.key,
    meta: shortcut.modifiers.meta,
    ctrl: shortcut.modifiers.ctrl,
    alt: shortcut.modifiers.alt,
    shift: shortcut.modifiers.shift,
  };
}

/** Find the first app shortcut that already owns the voice input key combo. */
export function findVoiceInputAppShortcutConflict(
  shortcut: VoiceInputShortcut,
  appShortcuts: ReadonlyArray<AppShortcutComboEntry>,
): AppShortcutId | null {
  const combo = voiceInputShortcutToAppShortcutCombo(shortcut);
  if (!combo) return null;
  for (const entry of appShortcuts) {
    if (entry.combos.some((appCombo) => appShortcutCombosEqual(appCombo, combo))) {
      return entry.id;
    }
  }
  return null;
}
