# Leo voice: push-to-talk dictation and read-aloud (WP-60, macOS)

## Rule

- Local only. `packages/desktop/native/leo-speech/main.swift` (built by
  `scripts/build-leo-speech.mjs`, arm64 only, macOS 26 target) uses SpeechAnalyzer +
  SpeechTranscriber (`.volatileResults`, `.fastResults`) for dictation and AVSpeechSynthesizer for
  reading. Language assets are system-managed; first use may download them once, then it works
  offline. Shipped at `Contents/Resources/leo-speech/leo-speech`.
- Helper protocol: stdout JSON lines `warm | ready | installing | partial{text} | final{text} |
  error{code,message} | done`. `partial` always carries the full current text (finalized +
  volatile).
- Prewarm: dictation runs one resident `leo-speech serve` (stdin JSON `{"cmd":"start"[,"file"]}` /
  `stop` / `cancel`, EOF quits). It installs assets and prepares the analyzer before any key press
  (`warm`; never touches the microphone, so no TCC prompt until the first real start), keeps the
  model with `modelRetention: .processLifetime`, and prepares the next analyzer after every `done`.
  The renderer calls `leo:speech:prewarm` on `focusin` when a dictation target exists (at most once
  a minute); main exits the helper after `SPEECH_IDLE_RELEASE_MS` (10 min) idle, or when the locale
  changes / dictation is turned off.
- Latency (dev, macOS 27, `say` audio fed at real time, measured from `start` to first partial):
  cold spawn → `warm` ≈ 0.5 s, then `ready` ≈ 2–70 ms. SpeechTranscriber alone emits its first
  partial ≈ 1.05 s after audio starts no matter how warm it is; DictationTranscriber ≈ 0.53 s but is
  worse on mixed Chinese/English. So the analyzer hosts both: Dictation text is shown until
  SpeechTranscriber has text, then replaced; the final text is SpeechTranscriber's (Dictation only as
  a fallback). Measured first partial ≈ 0.54–0.61 s (target 0.4 s not reached).
- Vocabulary: `AnalysisContext.contextualStrings[.general]` carries ~40 tech words (pull request,
  commit, push, merge, Claude, Codex, …; `--no-vocab` disables). A/B on 5 mixed phrases: no change
  for SpeechTranscriber, one phrase improved for Dictation. Kept because it is free.
- Main (`main/leo/speech.ts`) owns processes and settings (`userData/leo-speech.json`:
  dictationEnabled, readAloudEnabled, accelerator default `Alt+\``, locale). One dictation and one
  read-aloud globally (a new start cancels the previous one). IPC only from app windows.
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
- `leo-speech transcribe <say.aiff> [--no-vocab]`; dev end-to-end with `LEO_SPEECH_TEST_FILE=<aiff>` (dev builds
  only) which feeds a file at real-time speed instead of the microphone.
