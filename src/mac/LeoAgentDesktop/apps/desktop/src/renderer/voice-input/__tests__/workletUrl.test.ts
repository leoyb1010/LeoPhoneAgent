import { describe, expect, it } from 'vitest';

import { resolveVoiceInputWorkletUrl } from '../workletUrl';

describe('resolveVoiceInputWorkletUrl', () => {
  it('keeps dev-server root-relative URLs root-relative to the server', () => {
    expect(resolveVoiceInputWorkletUrl(
      '/src/renderer/voice-input/pcm16k-worklet.js?url',
      'http://localhost:5173/?view=voice-input-overlay',
    )).toBe('http://localhost:5173/src/renderer/voice-input/pcm16k-worklet.js?url');
  });

  it('keeps absolute worklet URLs unchanged', () => {
    expect(resolveVoiceInputWorkletUrl(
      'https://cdn.example.com/assets/pcm16k-worklet.js',
      'file:///Applications/xdt-maker.app/Contents/Resources/app.asar/.vite/renderer/main_window/index.html',
    )).toBe('https://cdn.example.com/assets/pcm16k-worklet.js');
  });

  it('rewrites packaged root-relative asset URLs next to index.html', () => {
    expect(resolveVoiceInputWorkletUrl(
      '/assets/pcm16k-worklet-AbCdEf.js',
      'file:///Applications/xdt-maker.app/Contents/Resources/app.asar/.vite/renderer/main_window/index.html?view=voice-input-overlay',
    )).toBe(
      'file:///Applications/xdt-maker.app/Contents/Resources/app.asar/.vite/renderer/main_window/assets/pcm16k-worklet-AbCdEf.js',
    );
  });
});
