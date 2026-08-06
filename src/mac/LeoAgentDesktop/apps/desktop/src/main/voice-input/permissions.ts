export type VoiceInputMicrophonePermissionCache =
  | { ok: true; status: string }
  | { ok: false; status: string; error: string };

export function isExplicitMicrophonePermissionDenied(status: string): boolean {
  return status === 'denied' || status === 'restricted';
}

export function getMicrophoneSettingsUrl(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') {
    return 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
  }
  if (platform === 'win32') {
    return 'ms-settings:privacy-microphone';
  }
  return null;
}

function getMicrophonePermissionError(platform: NodeJS.Platform): string {
  const settingsName = platform === 'win32' ? 'Windows Settings' : 'macOS System Settings';
  return `Microphone permission is required for voice input. Enable it in ${settingsName}.`;
}

export function resolveMicrophonePermissionSnapshot(
  status: string,
  rendererVerified: boolean,
  platform: NodeJS.Platform,
): VoiceInputMicrophonePermissionCache {
  if (status === 'granted' || (rendererVerified && !isExplicitMicrophonePermissionDenied(status))) {
    return { ok: true, status };
  }
  return {
    ok: false,
    status,
    error: getMicrophonePermissionError(platform),
  };
}
