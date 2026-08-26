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

  onComplete(_id: string, _msg: string): void {
  }

  onError(_id: string, code: number, message: string): void {
    this.onFail(`${code} ${message}`);
  }
}

export class Voice {
  private static capturing: boolean = false;
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
    onError: (message: string) => void): Promise<() => void> {
    Voice.stopSpeak();
    const at = abilityAccessCtrl.createAtManager();
    const perm: Permissions = 'ohos.permission.MICROPHONE';
    const grant = await at.requestPermissionsFromUser(context, [perm]);
    if (grant.authResults.length === 0 || grant.authResults[0] !== 0) {
      throw new Error('没有麦克风权限');
    }
    const engine = await speechRecognizer.createEngine(new Recreate());
    const hook = new RecoHook();
    hook.onText = onText;
    hook.onFail = onError;
    engine.setListener(hook);
    engine.startListening(new StartSpec());
    const capturer = await audio.createAudioCapturer(new CapturerOpts());
    await capturer.start();
    Voice.capturing = true;
    Voice.pump(engine, capturer);
    return () => {
      Voice.capturing = false;
      try {
        capturer.stop();
        capturer.release();
      } catch (_err) {
        // already closed
      }
      try {
        engine.finish('leo');
        engine.shutdown();
      } catch (_err) {
        // already closed
      }
    };
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

  private static pump(engine: speechRecognizer.SpeechRecognitionEngine, capturer: audio.AudioCapturer): void {
    const step = (): void => {
      if (!Voice.capturing) {
        return;
      }
      capturer.read(3200, true).then((buf: ArrayBuffer) => {
        if (Voice.capturing) {
          engine.writeAudio('leo', new Uint8Array(buf));
          step();
        }
      }).catch(() => {
        Voice.capturing = false;
      });
    };
    step();
  }
}
