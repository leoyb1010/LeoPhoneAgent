import { describe, expect, it } from 'vitest';

import {
  getMicrophoneSettingsUrl,
  resolveMicrophonePermissionSnapshot,
} from '../permissions.js';

describe('resolveMicrophonePermissionSnapshot', () => {
  it('trusts a renderer-side getUserMedia verification while macOS status is still inconclusive', () => {
    expect(resolveMicrophonePermissionSnapshot('not-determined', true, 'darwin')).toEqual({
      ok: true,
      status: 'not-determined',
    });
    expect(resolveMicrophonePermissionSnapshot('unknown', true, 'darwin')).toEqual({
      ok: true,
      status: 'unknown',
    });
  });

  it('does not let a stale renderer verification override an explicit macOS denial', () => {
    expect(resolveMicrophonePermissionSnapshot('denied', true, 'darwin')).toEqual({
      ok: false,
      status: 'denied',
      error: 'Microphone permission is required for voice input. Enable it in macOS System Settings.',
    });
    expect(resolveMicrophonePermissionSnapshot('restricted', true, 'darwin')).toEqual({
      ok: false,
      status: 'restricted',
      error: 'Microphone permission is required for voice input. Enable it in macOS System Settings.',
    });
  });

  it('reports explicit Windows denials as unavailable', () => {
    expect(resolveMicrophonePermissionSnapshot('denied', false, 'win32')).toEqual({
      ok: false,
      status: 'denied',
      error: 'Microphone permission is required for voice input. Enable it in Windows Settings.',
    });
  });
});

describe('getMicrophoneSettingsUrl', () => {
  it('returns the native microphone privacy page on macOS and Windows', () => {
    expect(getMicrophoneSettingsUrl('darwin')).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    );
    expect(getMicrophoneSettingsUrl('win32')).toBe('ms-settings:privacy-microphone');
    expect(getMicrophoneSettingsUrl('linux')).toBeNull();
  });
});
