# Leo voice: push-to-talk dictation and read-aloud (WP-60, macOS)

## Rule

- Local only. `packages/desktop/native/leo-speech/main.swift` (built by
  `scripts/build-leo-speech.mjs`, universal, macOS 26 target) uses SpeechAnalyzer +
  SpeechTranscriber (`.volatileResults`, `.fastResults`) for dictation and AVSpeechSynthesizer for
  reading. Language assets are system-managed; first use may download them once, then it works
  offline. Shipped at `Contents/Resources/leo-speech/leo-speech`.
- Helper protocol: stdout JSON lines `ready | installing | partial{text} | final{text} |
  error{code,message} | done`; `listen` ends on stdin `stop` / EOF. `partial` always carries the
  full current text (finalized + volatile).
- Main (`main/leo/speech.ts`) owns processes and settings (`userData/leo-speech.json`:
  dictationEnabled, readAloudEnabled, accelerator default `Alt+\``, locale). One dictation per
  window, one read-aloud globally. IPC only from app windows.
- Renderer (`LeoPushToTalk`, mounted in Root): while a LeoBot window is focused, holding the
  accelerator starts listening; text replaces the previous partial in the focused input (or the
  visible chat composer) through native selection + `insertText`, so Lexical/textarea treat it as
  typing. Releasing the main key or a required modifier stops; the final text stays. A bottom pill
  shows 正在听 / 准备资源 / errors (mic denied → button to Privacy › Microphone). The `⌥\`` dead key
  is swallowed.
- Read-aloud: 朗读 button in the assistant action bar (`LeoSpeakAction`); markdown is flattened
  (code blocks skipped, link targets dropped, 4000-char cap). A second click stops.
- Settings: 设置 → 键盘快捷键 → 语音 block (toggle dictation, record accelerator, toggle read-aloud).
- Packaging: `NSMicrophoneUsageDescription` and `com.apple.security.device.audio-input`
  (main + inherit entitlements) for hardened runtime.

## Verification

- `node --import tsx --test packages/desktop/src/main/leo/speechCore.test.ts` and
  `packages/ui/test/quickEntryAccelerator.test.ts`.
- `leo-speech transcribe <say.aiff>`; dev end-to-end with `LEO_SPEECH_TEST_FILE=<aiff>` (dev builds
  only) which feeds a file at real-time speed instead of the microphone.
