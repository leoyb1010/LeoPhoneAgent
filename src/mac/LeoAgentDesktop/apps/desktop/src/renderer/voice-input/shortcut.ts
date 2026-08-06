import {
  createVoiceInputShortcutFromMacNativeKeys,
  isVoiceInputMacNativeKeyboardShortcut,
  isVoiceInputModifierShortcut,
  isVoiceInputModifierShortcutCode,
  voiceInputShortcutNeedsMacNativeListener,
  type VoiceInputShortcutTrigger,
} from '../../shared/voiceInputData';
import {
  isMacReservedShortcut as isSharedMacReservedShortcut,
  isWindowsReservedShortcut as isSharedWindowsReservedShortcut,
} from '../../shared/keyboardReserved';

export { createVoiceInputShortcutFromMacNativeKeys };
export { voiceInputShortcutNeedsMacNativeListener };

export interface VoiceInputShortcut {
  trigger?: VoiceInputShortcutTrigger;
  code: string;
  key: string;
  modifiers: {
    meta: boolean;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    fn: boolean;
  };
}

const MODIFIER_CODES = new Set([
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'MetaLeft',
  'MetaRight',
  'ShiftLeft',
  'ShiftRight',
]);

const ALLOWED_BARE_MODIFIER_CODES = new Set([
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'MetaLeft',
  'MetaRight',
  'Fn',
]);

const KEY_LABELS: Record<string, string> = {
  Backspace: 'Backspace',
  Delete: 'Delete',
  Enter: 'Enter',
  Escape: 'Esc',
  Space: 'Space',
  Tab: 'Tab',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

export function getDefaultVoiceInputShortcut(): VoiceInputShortcut {
  if (isMacLikePlatform()) {
    return {
      trigger: 'keyboard',
      code: 'Space',
      key: ' ',
      modifiers: {
        meta: false,
        ctrl: false,
        alt: true,
        shift: false,
        fn: false,
      },
    };
  }

  return {
    trigger: 'keyboard',
    code: 'Space',
    key: ' ',
    modifiers: {
      meta: false,
      ctrl: true,
      alt: false,
      shift: true,
      fn: false,
    },
  };
}

export function normalizeVoiceInputShortcut(raw: unknown): VoiceInputShortcut | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<VoiceInputShortcut>;
  const modifiers = candidate.modifiers;
  const trigger = candidate.trigger === 'modifier' ? 'modifier' : 'keyboard';
  if (
    typeof candidate.code !== 'string' ||
    candidate.code.trim().length === 0
  ) {
    return null;
  }
  if (trigger === 'modifier') {
    if (!isVoiceInputModifierShortcutCode(candidate.code)) return null;
    return {
      trigger: 'modifier',
      code: candidate.code,
      key: typeof candidate.key === 'string' ? candidate.key : candidate.code,
      modifiers: {
        meta: false,
        ctrl: false,
        alt: false,
        shift: false,
        fn: false,
      },
    };
  }
  if (!modifiers || typeof modifiers !== 'object') return null;

  return {
    trigger: 'keyboard',
    code: candidate.code,
    key: typeof candidate.key === 'string' ? candidate.key : candidate.code,
    modifiers: {
      meta: Boolean(modifiers.meta),
      ctrl: Boolean(modifiers.ctrl),
      alt: Boolean(modifiers.alt),
      shift: Boolean(modifiers.shift),
      fn: Boolean((modifiers as { fn?: unknown }).fn),
    },
  };
}

export function createVoiceInputShortcutFromEvent(event: KeyboardEvent): VoiceInputShortcut | null {
  const modifierCode = getAllowedBareModifierCode(event);
  if (modifierCode) {
    return createVoiceInputModifierShortcut(modifierCode);
  }
  if (!event.code || isModifierOnlyEvent(event)) return null;

  return {
    trigger: 'keyboard',
    code: event.code,
    key: event.key,
    modifiers: {
      meta: event.metaKey,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      fn: event.getModifierState?.('Fn') ?? false,
    },
  };
}

export function createVoiceInputModifierShortcut(code: string): VoiceInputShortcut | null {
  if (!isVoiceInputModifierShortcutCode(code)) return null;
  return {
    trigger: 'modifier',
    code,
    key: code,
    modifiers: {
      meta: false,
      ctrl: false,
      alt: false,
      shift: false,
      fn: false,
    },
  };
}

export function getVoiceInputBareModifierCodeFromEvent(event: KeyboardEvent): string | null {
  return getAllowedBareModifierCode(event);
}

export function isVoiceInputShortcutMatch(
  event: KeyboardEvent,
  shortcut: VoiceInputShortcut | null,
): boolean {
  if (!shortcut) return false;
  if (isVoiceInputModifierShortcut(shortcut)) return false;
  if (shortcut.modifiers.fn) return false;
  return (
    event.code === shortcut.code &&
    event.metaKey === shortcut.modifiers.meta &&
    event.ctrlKey === shortcut.modifiers.ctrl &&
    event.altKey === shortcut.modifiers.alt &&
    event.shiftKey === shortcut.modifiers.shift
  );
}

export function isVoiceInputShortcutRelease(
  event: KeyboardEvent,
  shortcut: VoiceInputShortcut,
): boolean {
  if (isVoiceInputModifierShortcut(shortcut)) return event.code === shortcut.code;
  if (shortcut.modifiers.fn) return false;
  if (event.code === shortcut.code) return true;
  if (shortcut.modifiers.meta && (event.code === 'MetaLeft' || event.code === 'MetaRight')) return true;
  if (shortcut.modifiers.ctrl && (event.code === 'ControlLeft' || event.code === 'ControlRight')) return true;
  if (shortcut.modifiers.alt && (event.code === 'AltLeft' || event.code === 'AltRight')) return true;
  if (shortcut.modifiers.shift && (event.code === 'ShiftLeft' || event.code === 'ShiftRight')) return true;
  return false;
}

export function voiceInputShortcutHasModifier(shortcut: VoiceInputShortcut): boolean {
  return (
    shortcut.modifiers.meta ||
    shortcut.modifiers.ctrl ||
    shortcut.modifiers.alt ||
    shortcut.modifiers.shift ||
    shortcut.modifiers.fn
  );
}

export function isBarePrintableVoiceInputShortcut(shortcut: VoiceInputShortcut): boolean {
  return !voiceInputShortcutHasModifier(shortcut) && /^(Key[A-Z]|Digit[0-9])$/.test(shortcut.code);
}

export function isStandaloneVoiceInputShortcutAllowed(shortcut: VoiceInputShortcut): boolean {
  if (isVoiceInputModifierShortcut(shortcut)) return isMacLikePlatform();
  if (shortcut.modifiers.fn) return isMacLikePlatform() && isVoiceInputMacNativeKeyboardShortcut(shortcut);
  if (voiceInputShortcutHasModifier(shortcut)) return true;
  return /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(shortcut.code);
}

export function isSystemReservedVoiceInputShortcut(shortcut: VoiceInputShortcut): boolean {
  if (isVoiceInputModifierShortcut(shortcut)) return false;
  if (shortcut.modifiers.fn) return false;
  if (isMacLikePlatform()) return isMacReservedShortcut(shortcut);
  if (isWindowsLikePlatform()) return isWindowsReservedShortcut(shortcut);
  return false;
}

export function formatVoiceInputShortcut(shortcut: VoiceInputShortcut | null): string {
  if (!shortcut) return '';
  if (isVoiceInputModifierShortcut(shortcut)) return formatModifierShortcutKey(shortcut.code);
  const parts: string[] = [];
  if (isMacLikePlatform()) {
    if (shortcut.modifiers.fn) parts.push('Fn');
    if (shortcut.modifiers.ctrl) parts.push('⌃');
    if (shortcut.modifiers.alt) parts.push('⌥');
    if (shortcut.modifiers.shift) parts.push('⇧');
    if (shortcut.modifiers.meta) parts.push('⌘');
    parts.push(formatShortcutKey(shortcut));
    return shortcut.modifiers.fn ? parts.join('+') : parts.join('');
  }

  if (shortcut.modifiers.fn) parts.push('Fn');
  if (shortcut.modifiers.ctrl) parts.push('Ctrl');
  if (shortcut.modifiers.alt) parts.push('Alt');
  if (shortcut.modifiers.shift) parts.push('Shift');
  if (shortcut.modifiers.meta) parts.push('Meta');
  parts.push(formatShortcutKey(shortcut));
  return parts.join(' + ');
}

function isMacLikePlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}

function isWindowsLikePlatform(): boolean {
  return typeof navigator !== 'undefined' && /Win/.test(navigator.platform);
}

function isModifierOnlyEvent(event: KeyboardEvent): boolean {
  return MODIFIER_CODES.has(event.code);
}

function getAllowedBareModifierCode(event: KeyboardEvent): string | null {
  const code = event.code || (event.key === 'Fn' ? 'Fn' : '');
  if (!ALLOWED_BARE_MODIFIER_CODES.has(code)) return null;
  return code;
}

// 保留键表已抽到 shared/keyboardReserved.ts (与应用级快捷键共用), 这里只做
// VoiceInputShortcut → ReservedShortcutInput 的形状适配。
function isMacReservedShortcut(shortcut: VoiceInputShortcut): boolean {
  return isSharedMacReservedShortcut({
    code: shortcut.code,
    meta: shortcut.modifiers.meta,
    ctrl: shortcut.modifiers.ctrl,
    alt: shortcut.modifiers.alt,
    shift: shortcut.modifiers.shift,
  });
}

function isWindowsReservedShortcut(shortcut: VoiceInputShortcut): boolean {
  return isSharedWindowsReservedShortcut({
    code: shortcut.code,
    meta: shortcut.modifiers.meta,
    ctrl: shortcut.modifiers.ctrl,
    alt: shortcut.modifiers.alt,
    shift: shortcut.modifiers.shift,
  });
}

function formatShortcutKey(shortcut: VoiceInputShortcut): string {
  const explicit = KEY_LABELS[shortcut.code];
  if (explicit) return explicit;
  const keyFromCode = shortcut.code.match(/^Key([A-Z])$/)?.[1] ?? shortcut.code.match(/^Digit([0-9])$/)?.[1];
  if (keyFromCode) return keyFromCode;
  if (shortcut.key && shortcut.key.length === 1) return shortcut.key.toUpperCase();
  return shortcut.key || shortcut.code;
}

function formatModifierShortcutKey(code: string): string {
  if (isMacLikePlatform()) {
    switch (code) {
      case 'MetaLeft': return 'L⌘';
      case 'MetaRight': return 'R⌘';
      case 'AltLeft': return 'L⌥';
      case 'AltRight': return 'R⌥';
      case 'ControlLeft': return 'L⌃';
      case 'ControlRight': return 'R⌃';
      case 'Fn': return 'Fn';
      default: return code;
    }
  }
  switch (code) {
    case 'MetaLeft': return 'Left Meta';
    case 'MetaRight': return 'Right Meta';
    case 'AltLeft': return 'Left Alt';
    case 'AltRight': return 'Right Alt';
    case 'ControlLeft': return 'Left Ctrl';
    case 'ControlRight': return 'Right Ctrl';
    case 'Fn': return 'Fn';
    default: return code;
  }
}
