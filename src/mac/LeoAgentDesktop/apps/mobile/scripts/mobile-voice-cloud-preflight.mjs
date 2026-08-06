#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import WebSocket from 'ws';

const scriptDir = resolve(fileURLToPath(import.meta.url), '..');
const mobileRoot = resolve(scriptDir, '..');

const DEFAULT_ASR_ENDPOINT = '/openai/passthrough/v1/realtime?intent=transcription';
const DEFAULT_ASR_MODEL = 'gpt-realtime-whisper';
const DEFAULT_REFINER_ENDPOINT = '/v1/chat/completions';
const DEFAULT_REFINER_MODEL = 'gpt-5.4-mini';
const DEFAULT_TIMEOUT_MS = 10_000;
const VOLCENGINE_MODEL_NAME = 'bigmodel';
const VOLCENGINE_GRACE_MS = 2_500;

loadEnvFile(resolve(mobileRoot, '.env'));

const options = parseArgs(process.argv.slice(2));
const credential = resolveCredential(options);
const timeoutMs = parsePositiveInteger(options.timeoutMs ?? process.env.XDT_MOBILE_VOICE_PREFLIGHT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
const runAsr = options.refineOnly !== true;
const runRefine = options.asrOnly !== true;
const allCandidates = options.allCandidates === true;

if (!credential) {
  printMissingConfig();
  process.exit(2);
}

const errors = validateCredential(credential);
if (errors.length > 0) {
  console.error('mobile-voice-cloud-preflight config failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(2);
}

printSummary(credential, { runAsr, runRefine, timeoutMs, dryRun: !options.run, allCandidates });

if (!options.run) {
  console.log('mobile-voice-cloud-preflight dry run passed; add --run to call the cloud endpoints.');
  process.exit(0);
}

try {
  if (runAsr) await preflightAsrCandidates(credential, { timeoutMs, allCandidates });
  if (runRefine) await preflightRefinerCandidates(credential, { timeoutMs, allCandidates });
  console.log('mobile-voice-cloud-preflight passed');
} catch (error) {
  console.error(`mobile-voice-cloud-preflight failed: ${redact(error, credential)}`);
  process.exit(1);
}

function resolveCredential(opts) {
  const rawCredential = opts.credentialJson ?? process.env.XDT_MOBILE_VOICE_CREDENTIAL_JSON;
  const credentialPath = opts.credentialFile ?? process.env.XDT_MOBILE_VOICE_CREDENTIAL_FILE;
  if (rawCredential) {
    return JSON.parse(rawCredential);
  }
  if (credentialPath) {
    return JSON.parse(readFileSync(resolve(credentialPath), 'utf8'));
  }
  if (!process.env.XDT_MOBILE_VOICE_PROXY_BASE_URL && !process.env.XDT_MOBILE_VOICE_PROXY_API_KEY) {
    return null;
  }
  return {
    temporary: true,
    credentialVersion: 1,
    issuedAt: new Date(0).toISOString(),
    proxyBaseUrl: process.env.XDT_MOBILE_VOICE_PROXY_BASE_URL,
    proxyApiKey: process.env.XDT_MOBILE_VOICE_PROXY_API_KEY,
    asr: {
      provider: process.env.XDT_MOBILE_VOICE_ASR_PROVIDER ?? 'manual-openai-realtime',
      model: process.env.XDT_MOBILE_VOICE_ASR_MODEL ?? DEFAULT_ASR_MODEL,
      auth: 'api-key',
      mode: process.env.XDT_MOBILE_VOICE_ASR_MODE ?? 'realtime-websocket',
      endpointPath: process.env.XDT_MOBILE_VOICE_ASR_ENDPOINT_PATH ?? DEFAULT_ASR_ENDPOINT,
      pcmSampleRate: parsePositiveInteger(process.env.XDT_MOBILE_VOICE_ASR_SAMPLE_RATE, 24_000),
      protocolProfile: process.env.XDT_MOBILE_VOICE_ASR_PROTOCOL_PROFILE ?? 'openai-transcription-manual',
      litellmHeaderModel: process.env.XDT_MOBILE_VOICE_ASR_HEADER_MODEL,
      resourceId: process.env.XDT_MOBILE_VOICE_ASR_RESOURCE_ID,
    },
    refiner: {
      provider: process.env.XDT_MOBILE_VOICE_REFINER_PROVIDER ?? 'manual-litellm-chat',
      model: process.env.XDT_MOBILE_VOICE_REFINER_MODEL ?? DEFAULT_REFINER_MODEL,
      auth: 'api-key',
      transport: 'litellm-chat-completions',
      endpointPath: process.env.XDT_MOBILE_VOICE_REFINER_ENDPOINT_PATH ?? DEFAULT_REFINER_ENDPOINT,
    },
    settings: {
      language: process.env.XDT_MOBILE_VOICE_LANGUAGE ?? 'zh-CN',
      refinementEnabled: true,
      playInteractionSound: false,
    },
  };
}

function validateCredential(credential) {
  const errors = [];
  if (!credential || typeof credential !== 'object') errors.push('credential must be an object');
  if (!readString(credential?.proxyBaseUrl)) errors.push('proxyBaseUrl is required');
  if (!readString(credential?.proxyApiKey)) errors.push('proxyApiKey is required');
  validateAsrConfig(credential?.asr, 'asr', errors);
  validateProviderChain(credential, 'asrProviderChain', validateAsrConfig, errors);
  validateRefinerConfig(credential?.refiner, 'refiner', errors);
  validateProviderChain(credential, 'refinerProviderChain', validateRefinerConfig, errors);
  return errors;
}

function validateProviderChain(credential, property, validateItem, errors) {
  const chain = credential?.[property];
  if (chain === undefined) return;
  if (!Array.isArray(chain) || chain.length === 0) {
    errors.push(`${property} must be a non-empty array when provided`);
    return;
  }
  for (const [index, item] of chain.entries()) {
    validateItem(item, `${property}[${index}]`, errors);
  }
}

function validateAsrConfig(asr, label, errors) {
  if (!asr || typeof asr !== 'object') {
    errors.push(`${label} config is required`);
    return;
  }
  if (!readString(asr.model)) errors.push(`${label}.model is required`);
  if (!readString(asr.endpointPath)) errors.push(`${label}.endpointPath is required`);
  if (!readString(asr.mode)) errors.push(`${label}.mode is required`);
  const unsupportedAsr = mobileRealtimeAsrUnsupportedReason(asr);
  if (unsupportedAsr) errors.push(`${label}: ${unsupportedAsr}`);
  if (
    asr.mode === 'provider-native-websocket'
    && asr.protocolProfile === 'volcengine-sauc-duration'
    && !readString(asr.resourceId)
  ) {
    errors.push(`${label}.resourceId is required for Volcengine ASR`);
  }
}

function validateRefinerConfig(refiner, label, errors) {
  if (!refiner || typeof refiner !== 'object') {
    errors.push(`${label} config is required`);
    return;
  }
  if (!readString(refiner.model)) errors.push(`${label}.model is required`);
  if (!readString(refiner.endpointPath)) errors.push(`${label}.endpointPath is required`);
  if (refiner.transport !== 'litellm-chat-completions') {
    errors.push(`${label}.transport must be litellm-chat-completions for mobile cloud preflight`);
  }
}

function mobileRealtimeAsrUnsupportedReason(asr) {
  if (!asr || typeof asr !== 'object') return null;
  if (asr.mode === 'realtime-websocket') {
    if (
      asr.protocolProfile === 'openai-transcription-manual'
      || asr.protocolProfile === 'qwen-asr-server-vad'
    ) {
      return null;
    }
    return `asr.protocolProfile is not supported for mobile realtime preflight: ${asr.protocolProfile ?? 'unknown'}`;
  }
  if (asr.mode === 'provider-native-websocket') {
    if (asr.protocolProfile === 'volcengine-sauc-duration') return null;
    return `asr.protocolProfile is not supported for mobile native preflight: ${asr.protocolProfile ?? 'unknown'}`;
  }
  return `asr.mode is not supported for mobile realtime preflight: ${asr.mode ?? 'unknown'}`;
}

async function preflightAsrCandidates(credential, { timeoutMs, allCandidates }) {
  const candidates = allCandidates ? credentialAsrChain(credential) : credentialAsrChain(credential).slice(0, 1);
  for (const [index, asr] of candidates.entries()) {
    await preflightAsr({ ...credential, asr }, {
      timeoutMs,
      label: `${asr.provider ?? 'asr'}#${index + 1}`,
    });
  }
}

async function preflightAsr(credential, { timeoutMs, label }) {
  if (credential.asr.mode === 'realtime-websocket') {
    await preflightOpenAiCompatibleAsr(credential, { timeoutMs, label });
    return;
  }
  if (
    credential.asr.mode === 'provider-native-websocket'
    && credential.asr.protocolProfile === 'volcengine-sauc-duration'
  ) {
    await preflightVolcengineAsr(credential, { timeoutMs, label });
    return;
  }
  throw new Error(`unsupported ASR preflight mode: ${credential.asr.mode} / ${credential.asr.protocolProfile ?? 'unknown'}`);
}

function preflightOpenAiCompatibleAsr(credential, { timeoutMs, label }) {
  const url = toWebSocketUrl(credential.proxyBaseUrl, credential.asr.endpointPath);
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${credential.proxyApiKey}`,
        ...(credential.asr.litellmHeaderModel ? { 'x-litellm-model': credential.asr.litellmHeaderModel } : {}),
      },
    });
    const timer = setTimeout(() => fail(new Error(`ASR websocket timed out after ${timeoutMs}ms`)), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      try { socket.close(); } catch { /* noop */ }
    };
    const fail = (error) => {
      cleanup();
      rejectPromise(error);
    };
    socket.on('open', () => {
      socket.send(JSON.stringify(buildSessionUpdateMessage(credential)));
    });
    socket.on('message', (raw) => {
      const event = parseJson(String(raw));
      if (!event || typeof event.type !== 'string') return;
      if (event.type === 'session.updated') {
        cleanup();
        console.log(`ASR preflight passed [${label}]: websocket session.updated`);
        resolvePromise();
      } else if (event.type === 'error') {
        fail(new Error(readErrorMessage(event.error) ?? 'ASR websocket returned error'));
      }
    });
    socket.on('error', fail);
    socket.on('close', (code, reason) => {
      fail(new Error(`ASR websocket closed before ready: ${code} ${reason?.toString?.() ?? ''}`.trim()));
    });
  });
}

function preflightVolcengineAsr(credential, { timeoutMs, label }) {
  if (!credential.asr.resourceId) throw new Error('Volcengine ASR preflight requires asr.resourceId');
  const url = toWebSocketUrl(credential.proxyBaseUrl, credential.asr.endpointPath);
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${credential.proxyApiKey}`,
        'X-Api-Resource-Id': credential.asr.resourceId,
        'X-Api-Connect-Id': `xdt-mobile-preflight-${Date.now()}`,
      },
    });
    let settled = false;
    let graceTimer = null;
    const timer = setTimeout(() => fail(new Error(`Volcengine ASR websocket timed out after ${timeoutMs}ms`)), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      try { socket.close(); } catch { /* noop */ }
    };
    const done = (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      console.log(`ASR preflight passed [${label}]: ${message}`);
      resolvePromise();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    socket.on('open', () => {
      socket.send(encodeVolcengineFullClientRequest({
        user: { uid: 'xdt-mobile-preflight' },
        audio: {
          format: 'pcm',
          codec: 'raw',
          rate: credential.asr.pcmSampleRate ?? 16_000,
          bits: 16,
          channel: 1,
        },
        request: {
          model_name: VOLCENGINE_MODEL_NAME,
          result_type: 'full',
          show_utterances: true,
          enable_nonstream: true,
        },
      }));
      graceTimer = setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) {
          done('Volcengine websocket stayed open after initial request');
        }
      }, Math.min(timeoutMs, VOLCENGINE_GRACE_MS));
    });
    socket.on('message', () => done('Volcengine websocket returned a server frame'));
    socket.on('error', fail);
    socket.on('close', (code, reason) => {
      fail(new Error(`Volcengine ASR websocket closed before ready: ${code} ${reason?.toString?.() ?? ''}`.trim()));
    });
  });
}

async function preflightRefinerCandidates(credential, { timeoutMs, allCandidates }) {
  const candidates = allCandidates ? credentialRefinerChain(credential) : credentialRefinerChain(credential).slice(0, 1);
  for (const [index, refiner] of candidates.entries()) {
    await preflightRefiner({ ...credential, refiner }, {
      timeoutMs,
      label: `${refiner.provider ?? 'refiner'}#${index + 1}`,
    });
  }
}

async function preflightRefiner(credential, { timeoutMs, label }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(joinProxyPath(credential.proxyBaseUrl, credential.refiner.endpointPath), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${credential.proxyApiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: credential.refiner.model,
        response_format: { type: 'json_object' },
        stream: true,
        messages: [
          {
            role: 'system',
            content: 'Return a compact JSON object with exactly one string field named "text".',
          },
          {
            role: 'user',
            content: JSON.stringify({
              text: 'mobile voice preflight',
              instruction: 'Return the same text plus " ok".',
            }),
          },
        ],
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`refiner HTTP ${response.status} ${response.statusText}: ${body.slice(0, 240)}`);
    }
    const content = await readChatCompletionContent(response);
    const parsed = parseJsonObject(content);
    if (typeof parsed.text !== 'string' || !parsed.text.trim()) {
      throw new Error('refiner response did not contain text');
    }
    console.log(`refiner preflight passed [${label}]: ${parsed.text.length} chars`);
  } finally {
    clearTimeout(timer);
  }
}

async function readChatCompletionContent(response) {
  const text = await response.text();
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let content = '';
  for (const block of normalized.split(/\n\n+/)) {
    const event = parseSseBlock(block);
    if (!event) continue;
    if (event.data === '[DONE]') continue;
    if (event.data?.error) throw new Error(readErrorMessage(event.data.error) ?? 'refiner stream returned error');
    const delta = event.data?.choices?.map((choice) => choice?.delta?.content ?? '').join('') ?? '';
    content += delta;
  }
  if (content.trim()) return content.trim();
  const payload = parseJsonObject(text);
  const message = payload?.choices?.[0]?.message?.content;
  if (typeof message === 'string') return message;
  throw new Error('refiner response did not contain chat content');
}

function parseSseBlock(block) {
  const lines = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
  }
  if (lines.length === 0) return null;
  const data = lines.join('\n');
  if (data === '[DONE]') return { data };
  return { data: parseJson(data) };
}

function buildSessionUpdateMessage(credential) {
  const language = normalizeLanguage(credential.settings?.language);
  if (credential.asr.protocolProfile === 'qwen-asr-server-vad') {
    return {
      event_id: `preflight_${Date.now()}`,
      type: 'session.update',
      session: {
        modalities: ['text'],
        input_audio_format: 'pcm',
        sample_rate: credential.asr.pcmSampleRate ?? 16_000,
        input_audio_transcription: {
          ...(language ? { language } : {}),
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0,
          silence_duration_ms: 400,
        },
      },
    };
  }
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: credential.asr.pcmSampleRate ?? 24_000 },
          transcription: {
            model: credential.asr.model,
            ...(language ? { language } : {}),
          },
          turn_detection: null,
        },
      },
    },
  };
}

function encodeVolcengineFullClientRequest(payload) {
  const body = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const header = Buffer.from([
    0x11, // version 1, header size 1 word
    0x10, // full client request, no sequence
    0x11, // json + gzip
    0x00,
  ]);
  const payloadSize = Buffer.alloc(4);
  payloadSize.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, payloadSize, body]);
}

function joinProxyPath(baseUrl, endpointPath) {
  const base = new URL(baseUrl);
  const endpoint = new URL(endpointPath, 'https://placeholder.invalid');
  const basePath = base.pathname.replace(/\/+$/, '');
  base.pathname = `${basePath}${endpoint.pathname}`;
  base.search = endpoint.search;
  return base.toString();
}

function toWebSocketUrl(baseUrl, endpointPath) {
  const url = new URL(joinProxyPath(baseUrl, endpointPath));
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  return url.toString();
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseJsonObject(value) {
  const parsed = typeof value === 'string' ? parseJson(value.trim()) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected JSON object');
  }
  return parsed;
}

function readErrorMessage(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.message === 'string') return value.message;
  if (typeof value.error === 'string') return value.error;
  return null;
}

function normalizeLanguage(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized || normalized === 'auto') return undefined;
  switch (normalized) {
    case 'chinese':
    case 'mandarin':
    case 'simplified chinese':
    case 'traditional chinese':
      return 'zh';
    case 'cantonese':
      return 'yue';
    case 'english':
      return 'en';
    case 'japanese':
      return 'ja';
    case 'korean':
      return 'ko';
  }
  const primary = normalized.split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

function redact(value, credential) {
  let text = value instanceof Error ? value.message : String(value);
  const key = credential?.proxyApiKey;
  if (typeof key !== 'string' || !key) return text;
  for (const candidate of redactionCandidates(key)) {
    text = text.split(candidate).join('[REDACTED]');
  }
  return text;
}

function printSummary(credential, { runAsr, runRefine, timeoutMs, dryRun, allCandidates }) {
  const asrChain = credentialAsrChain(credential);
  const refinerChain = credentialRefinerChain(credential);
  const primaryAsr = asrChain[0] ?? credential.asr;
  const primaryRefiner = refinerChain[0] ?? credential.refiner;
  console.log('mobile-voice-cloud-preflight');
  console.log(`- mode: ${dryRun ? 'dry-run' : 'run'}`);
  console.log(`- proxy: ${redactUrl(credential.proxyBaseUrl)}`);
  console.log(`- ASR: ${runAsr ? `${primaryAsr.mode} / ${primaryAsr.protocolProfile ?? 'unknown'} / ${primaryAsr.model}` : 'skipped'}`);
  console.log(`- ASR provider chain: ${runAsr ? `${asrChain.length} candidate(s)` : 'skipped'}`);
  console.log(`- refiner: ${runRefine ? `${primaryRefiner.transport} / ${primaryRefiner.model}` : 'skipped'}`);
  console.log(`- refiner provider chain: ${runRefine ? `${refinerChain.length} candidate(s)` : 'skipped'}`);
  console.log(`- candidate mode: ${allCandidates ? 'all provider candidates' : 'primary candidate only'}`);
  console.log(`- timeout: ${timeoutMs}ms`);
}

function credentialAsrChain(credential) {
  return uniqueCredentialProviderChain(credential?.asrProviderChain, credential?.asr);
}

function credentialRefinerChain(credential) {
  return uniqueCredentialProviderChain(credential?.refinerProviderChain, credential?.refiner);
}

function uniqueCredentialProviderChain(chain, fallback) {
  const source = Array.isArray(chain) && chain.length > 0 ? chain : fallback ? [fallback] : [];
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const provider = typeof item?.provider === 'string' && item.provider.trim()
      ? item.provider.trim()
      : `#${result.length}`;
    if (seen.has(provider)) continue;
    seen.add(provider);
    result.push(item);
  }
  return result;
}

function printMissingConfig() {
  console.error('mobile-voice-cloud-preflight needs either:');
  console.error('- --credential-file <path> with a MobileVoiceCredentialSyncResult JSON object');
  console.error('- XDT_MOBILE_VOICE_CREDENTIAL_JSON');
  console.error('- XDT_MOBILE_VOICE_PROXY_BASE_URL + XDT_MOBILE_VOICE_PROXY_API_KEY');
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '<invalid-url>';
  }
}

function redactionCandidates(secret) {
  const candidates = [
    secret,
    encodeURIComponent(secret),
    encodeURI(secret),
  ];
  return candidates.filter((candidate, index) =>
    candidate.length > 0 && candidates.indexOf(candidate) === index,
  );
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`invalid positive integer: ${value}`);
  return parsed;
}

function parseArgs(args) {
  const parsed = {
    allCandidates: process.env.XDT_MOBILE_VOICE_PREFLIGHT_ALL_CANDIDATES === '1',
    asrOnly: false,
    credentialFile: undefined,
    credentialJson: undefined,
    refineOnly: false,
    run: false,
    timeoutMs: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--run') {
      parsed.run = true;
      continue;
    }
    if (arg === '--all-candidates') {
      parsed.allCandidates = true;
      continue;
    }
    if (arg === '--asr-only') {
      parsed.asrOnly = true;
      continue;
    }
    if (arg === '--refine-only') {
      parsed.refineOnly = true;
      continue;
    }
    if (arg === '--credential-file') {
      parsed.credentialFile = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--credential-json') {
      parsed.credentialJson = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = readArgValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  if (parsed.asrOnly && parsed.refineOnly) throw new Error('--asr-only and --refine-only cannot be combined');
  return parsed;
}

function readArgValue(args, index, flag) {
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}
