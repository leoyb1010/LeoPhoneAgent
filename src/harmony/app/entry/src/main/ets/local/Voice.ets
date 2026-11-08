import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';
import { audio } from '@kit.AudioKit';
import { speechRecognizer, textToSpeech } from '@kit.CoreSpeechKit';

class Recreate {
  language: string = 'zh-CN';
  online: number = 0;
}

class SpeakCreate {
  language: string = 'zh-CN';
  person: number = 0;
  online: number = 0;
}

class AudioSpec {
  audioType: string = 'pcm';
  sampleRate: number = 16000;
  soundChannel: number = 1;
  sampleBit: number = 16;
}

class StartSpec {
  sessionId: string = 'leo';
  audioInfo: AudioSpec = new AudioSpec();
}

class SpeakSpec {
  requestId: string = `${Date.now()}`;
}

class StreamInfo {
  samplingRate: audio.AudioSamplingRate = audio.AudioSamplingRate.SAMPLE_RATE_16000;
  channels: audio.AudioChannel = audio.AudioChannel.CHANNEL_1;
  sampleFormat: audio.AudioSampleFormat = audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE;
  encodingType: audio.AudioEncodingType = audio.AudioEncodingType.ENCODING_TYPE_RAW;
}

class CapturerInfo {
  source: audio.SourceType = audio.SourceType.SOURCE_TYPE_MIC;
  capturerFlags: number = 0;
}

class CapturerOpts {
  streamInfo: StreamInfo = new StreamInfo();
  capturerInfo: CapturerInfo = new CapturerInfo();
}

class SpeakHook {
  private closed: boolean = false;
  onDone: () => void = () => {
  };

  onStart(_id: string, _resp: textToSpeech.StartResponse): void {
  }

  onComplete(_id: string, _resp: textToSpeech.CompleteResponse): void {
    this.finish();
  }

  onStop(_id: string, _resp: textToSpeech.StopResponse): void {
    this.finish();
  }

  onError(_id: string, _code: number, _message: string): void {
    this.finish();
  }

  private finish(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onDone();
  }
}

class RecoHook {
  onEnd: () => void = () => {};
  onText: (text: string, last: boolean) => void = (_t: string, _l: boolean) => {
  };
  onFail: (message: string) => void = (_m: string) => {
  };

  onStart(_id: string, _msg: string): void {
  }

  onEvent(_id: string, _code: number, _msg: string): void {
  }

  onResult(_id: string, result: speechRecognizer.SpeechRecognitionResult): void {
    if (result.result.length > 0) {
      this.onText(result.result, result.isLast || result.isFinal);
    }
  }

  onComplete(_id: string, _msg: string): void { this.onEnd(); }

  onError(_id: string, code: number, message: string): void {
    this.onFail(`${code} ${message}`);
  }
}

export class Voice {
  private static capturing: boolean = false;
  private static starting: boolean = false;
  private static captureVersion: number = 0;
  private static closing: Promise<void> | null = null;
  private static speaker: textToSpeech.TextToSpeechEngine | null = null;
  private static speakId: string = '';

  static stopSpeak(): void {
    if (!Voice.speaker) {
      return;
    }
    try {
      Voice.speaker.stop();
    } catch (_err) {
      // already closed
    }
    try {
      Voice.speaker.shutdown();
    } catch (_err) {
      // already closed
    }
    Voice.speaker = null;
    Voice.speakId = '';
  }

  static async listen(context: common.UIAbilityContext, onText: (text: string, last: boolean) => void,
    onError: (message: string) => void, isCurrent: () => boolean = () => true): Promise<() => void> {
    if (Voice.closing) await Voice.closing;
    if (!isCurrent()) throw new Error('语音输入已取消');
    if (Voice.starting || Voice.capturing) throw new Error('另一个会话正在语音输入，请先结束录音');
    Voice.starting = true;
    const version = ++Voice.captureVersion;
    let engine: speechRecognizer.SpeechRecognitionEngine | null = null;
    let capturer: audio.AudioCapturer | null = null;
    let captureCreation: Promise<audio.AudioCapturer> | null = null;
    let captureStart: Promise<void> | null = null;
    let closed = false;
    let lastText = '';
    const active = (): boolean => !closed && version === Voice.captureVersion && isCurrent();
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (version === Voice.captureVersion) Voice.capturing = false;
      const currentEngine = engine;
      if (currentEngine) {
        try { currentEngine.finish('leo'); } catch (_error) {}
        try { currentEngine.shutdown(); } catch (_error) {}
      }
      const release = captureCreation ? captureCreation.then(async (currentCapturer: audio.AudioCapturer): Promise<void> => {
        if (captureStart) await captureStart.catch(() => {});
        await currentCapturer.stop().catch(() => {}); await currentCapturer.release().catch(() => {});
      }).catch(() => {}) : Promise.resolve();
      Voice.closing = release.finally(() => {
        if (version === Voice.captureVersion) { Voice.starting = false; Voice.capturing = false; Voice.closing = null; }
      });
    };
    try {
      Voice.stopSpeak();
      const grant = await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(context, ['ohos.permission.MICROPHONE']);
      if (!active()) throw new Error('语音输入已取消');
      if (!grant.authResults.length || grant.authResults[0] !== 0) throw new Error('没有麦克风权限');
      engine = await speechRecognizer.createEngine(new Recreate());
      if (!active()) throw new Error('语音输入已取消');
      const hook = new RecoHook();
      hook.onText = (text: string, last: boolean) => {
        if (!active()) { close(); return; }
        lastText = text; onText(text, last); if (last) close();
      };
      hook.onFail = (message: string) => { const notify = active(); close(); if (notify) onError(message); };
      hook.onEnd = () => { const notify = active(); close(); if (notify) onText(lastText, true); };
      engine.setListener(hook);
      if (!active()) throw new Error('语音输入已取消');
      captureCreation = audio.createAudioCapturer(new CapturerOpts());
      capturer = await captureCreation;
      if (!active()) throw new Error('语音输入已取消');
      captureStart = capturer.start(); await captureStart;
      if (!active()) throw new Error('语音输入已取消');
      Voice.starting = false; Voice.capturing = true; engine.startListening(new StartSpec());
      Voice.pump(engine, capturer, active, (message: string) => { const notify = active(); close(); if (notify) onError(message); });
      return close;
    } catch (error) { close(); throw error as Error; }
  }

  static async speak(text: string): Promise<void> {
    if (text.trim().length === 0) {
      return;
    }
    Voice.stopSpeak();
    const engine = await textToSpeech.createEngine(new SpeakCreate());
    const spec = new SpeakSpec();
    spec.requestId = `tts_${Date.now()}`;
    Voice.speaker = engine;
    Voice.speakId = spec.requestId;
    const hook = new SpeakHook();
    hook.onDone = () => {
      if (Voice.speaker === engine) {
        Voice.speaker = null;
        Voice.speakId = '';
      }
      try {
        engine.shutdown();
      } catch (_err) {
        // already closed
      }
    };
    engine.setListener(hook);
    engine.speak(text, spec);
  }

  private static pump(engine: speechRecognizer.SpeechRecognitionEngine, capturer: audio.AudioCapturer,
    active: () => boolean, onError: (message: string) => void): void {
    const step = (): void => {
      if (!active()) return;
      capturer.read(3200, true).then((buffer: ArrayBuffer) => {
        if (!active()) return;
        engine.writeAudio('leo', new Uint8Array(buffer)); step();
      }).catch((error: Error) => { if (active()) onError(error.message || '录音读取失败'); });
    };
    step();
  }
}
