#!/usr/bin/env node
// Offline probe: replay a voice recording through OpenAI realtime whisper,
// optionally with a `prompt` field, and print the resulting transcript.
// Lets us A/B test if `prompt` actually influences output without going
// through the flaky F16-via-osascript scenario benchmark.
//
// Usage:
//   node scripts/voice-input-prompt-probe.mjs <audio.wav> [--prompt "text"]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';

const OPENAI_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const MODEL = 'gpt-realtime-whisper';
const TARGET_RATE = 24_000;
const CHUNK_MS = 40;

function parseArgs(argv) {
  const out = { audio: null, prompt: null, language: 'zh' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--prompt') out.prompt = argv[++i];
    else if (a === '--language') out.language = argv[++i];
    else if (!out.audio) out.audio = a;
  }
  if (!out.audio) {
    console.error('usage: voice-input-prompt-probe.mjs <audio.wav> [--prompt "text"] [--language zh|en|auto]');
    process.exit(2);
  }
  return out;
}

function readToken() {
  const data = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex/auth.json'), 'utf8'));
  return data.tokens?.access_token;
}

function parseWavPcm16Mono(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const ascii = (start, len) => String.fromCharCode(...bytes.subarray(start, start + len));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let offset = 12;
  let channels = 0, sampleRate = 0, bitsPerSample = 0, audioFormat = 0;
  let dataOffset = 0, dataSize = 0;
  while (offset + 8 <= view.byteLength) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      audioFormat = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') { dataOffset = body; dataSize = size; }
    offset = body + size + (size % 2);
  }
  if (audioFormat !== 1 || bitsPerSample !== 16) throw new Error('only PCM16 WAV supported');
  const frameCount = Math.floor(dataSize / (channels * 2));
  const samples = new Int16Array(frameCount);
  for (let f = 0; f < frameCount; f += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += view.getInt16(dataOffset + (f * channels + c) * 2, true);
    samples[f] = Math.max(-32768, Math.min(32767, Math.round(sum / channels)));
  }
  return { sampleRate, samples };
}

function resamplePcm16(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const out = new Int16Array(Math.round(samples.length * toRate / fromRate));
  const ratio = fromRate / toRate;
  for (let i = 0; i < out.length; i += 1) {
    const src = i * ratio;
    const l = Math.floor(src);
    const r = Math.min(samples.length - 1, l + 1);
    const t = src - l;
    out[i] = Math.round(samples[l] * (1 - t) + samples[r] * t);
  }
  return out;
}

function pcm16ToBase64(samples) {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64');
}

async function main() {
  const opts = parseArgs(process.argv);
  const token = readToken();
  if (!token) { console.error('no access_token in ~/.codex/auth.json'); process.exit(2); }

  const wav = parseWavPcm16Mono(fs.readFileSync(opts.audio));
  const samples24k = resamplePcm16(wav.samples, wav.sampleRate, TARGET_RATE);
  const durationMs = (samples24k.length / TARGET_RATE) * 1000;

  console.error(`audio: ${opts.audio} (${wav.sampleRate}Hz → ${TARGET_RATE}Hz, ${durationMs.toFixed(0)}ms)`);
  console.error(`prompt: ${opts.prompt ? JSON.stringify(opts.prompt) : '<absent>'}`);

  const ws = new WebSocket(OPENAI_URL, { headers: { Authorization: `Bearer ${token}` } });
  const transcripts = [];
  let sessionConfig = null;

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('open timeout')), 10_000);
    ws.once('open', () => { clearTimeout(t); resolve(); });
    ws.once('error', reject);
  });

  const sessionUpdate = {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: TARGET_RATE },
          transcription: {
            model: MODEL,
            language: opts.language === 'auto' ? undefined : opts.language,
            ...(opts.prompt ? { prompt: opts.prompt } : {}),
          },
          turn_detection: null,
        },
      },
    },
  };
  ws.send(JSON.stringify(sessionUpdate));

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('session.updated timeout')), 10_000);
    const onMsg = (data) => {
      const e = JSON.parse(data.toString());
      if (e.type === 'session.updated') {
        sessionConfig = e.session?.audio?.input?.transcription || null;
        clearTimeout(t);
        ws.off('message', onMsg);
        resolve();
      } else if (e.type === 'error') {
        clearTimeout(t);
        ws.off('message', onMsg);
        reject(new Error(e.error?.message || 'session.update error'));
      }
    };
    ws.on('message', onMsg);
  });

  console.error('server echoed transcription:', JSON.stringify(sessionConfig));

  // Stream audio in chunks
  const chunkSamples = Math.round(TARGET_RATE * CHUNK_MS / 1000);
  const completed = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('completed timeout')), Math.round(durationMs) + 30_000);
    ws.on('message', (data) => {
      const e = JSON.parse(data.toString());
      if (e.type === 'conversation.item.input_audio_transcription.completed') {
        transcripts.push(e.transcript || '');
        clearTimeout(t);
        resolve();
      } else if (e.type === 'error') {
        clearTimeout(t);
        reject(new Error(e.error?.message || 'streaming error'));
      }
    });
  });

  // Send audio at real-time pace to mimic live streaming
  for (let off = 0; off < samples24k.length; off += chunkSamples) {
    const slice = samples24k.subarray(off, Math.min(samples24k.length, off + chunkSamples));
    ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: pcm16ToBase64(slice),
    }));
    await new Promise((r) => setTimeout(r, CHUNK_MS));
  }
  ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  console.error('audio sent, committed; waiting for completed event…');

  await completed;
  ws.close();

  const fullTranscript = transcripts.join('');
  console.log(fullTranscript);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
