/**
 * [leo][WP-60] 主进程 leoSpeech bridge 的类型与取用(只有 macOS 桌面端有)。规则见 docs/specs/leo-speech.md。
 */

export interface LeoSpeechSettings {
  dictationEnabled: boolean;
  readAloudEnabled: boolean;
  accelerator: string;
  locale: string | null;
}

interface LeoSpeechSettingsResult {
  settings?: LeoSpeechSettings;
  available?: boolean;
  error?: string;
}

export type LeoSpeechEvent =
  | { type: "ready"; locale?: string }
  | { type: "installing" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; code: string; message: string }
  | { type: "done" };

interface LeoSpeechBridge {
  getSettings(): Promise<LeoSpeechSettingsResult>;
  setSettings(patch: Partial<LeoSpeechSettings>): Promise<LeoSpeechSettingsResult>;
  start(): Promise<{ ok: boolean; error?: string }>;
  stop(): Promise<boolean>;
  onEvent(callback: (event: LeoSpeechEvent) => void): () => void;
  speak(markdown: string): Promise<{ ok: boolean; error?: string }>;
  stopSpeaking(): Promise<boolean>;
  onSpeakState(callback: (state: { speaking: boolean }) => void): () => void;
  openMicSettings(): Promise<boolean>;
}

export function leoSpeechBridge(): LeoSpeechBridge | null {
  // [leo] 非浏览器环境（SSR/Node 测试）没有 window。
  if (typeof window === "undefined") return null;
  return (window as unknown as { leoSpeech?: LeoSpeechBridge }).leoSpeech ?? null;
}
