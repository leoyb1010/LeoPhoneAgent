let audioContext: AudioContext | null = null;

type VoiceInputCue = {
  fromFrequency: number;
  toFrequency: number;
  rampAt: number;
  duration: number;
  volume: number;
  delay?: number;
  attack?: number;
};

function getAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
  }
  return audioContext;
}

export function prepareVoiceInputCues(): void {
  try {
    getAudioContext();
  } catch {
    // Audio feedback is optional; recording must not depend on it.
  }
}

function playVoiceInputCue(cue: VoiceInputCue): void {
  try {
    const context = getAudioContext();
    const startedAt = context.currentTime + 0.005 + (cue.delay ?? 0);
    const endedAt = startedAt + cue.duration;
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(cue.fromFrequency, startedAt);
    oscillator.frequency.exponentialRampToValueAtTime(cue.toFrequency, startedAt + cue.rampAt);

    gain.gain.setValueAtTime(0.0001, startedAt);
    gain.gain.exponentialRampToValueAtTime(cue.volume, startedAt + (cue.attack ?? 0.01));
    gain.gain.exponentialRampToValueAtTime(0.0001, endedAt);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(startedAt);
    oscillator.stop(endedAt);

    if (context.state === 'suspended') {
      void context.resume().catch(() => {});
    }
  } catch {
    // Ignore playback failures. The microphone startup path must stay non-blocking.
  }
}

export function playVoiceInputStartCue(): void {
  playVoiceInputCue({
    fromFrequency: 720,
    toFrequency: 920,
    rampAt: 0.045,
    duration: 0.11,
    volume: 0.095,
    attack: 0.006,
  });
}

export function playVoiceInputEndCue(): void {
  // End feedback keeps the same simple sine-glide timbre as the start cue. The
  // only distinction is the two-note low-to-high rhythm, which marks "stop"
  // without introducing a separate alert-like sound.
  playVoiceInputCue({
    fromFrequency: 520,
    toFrequency: 660,
    rampAt: 0.045,
    duration: 0.11,
    volume: 0.095,
    attack: 0.006,
  });
  playVoiceInputCue({
    fromFrequency: 720,
    toFrequency: 920,
    rampAt: 0.045,
    duration: 0.11,
    volume: 0.095,
    delay: 0.16,
    attack: 0.006,
  });
}
