#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PROTOCOL_VERSION = 1;
const DEFAULT_API_BASE = 'http://localhost:3333';
const scriptDir = resolve(fileURLToPath(import.meta.url), '..');
const mobileRoot = resolve(scriptDir, '..');
const repoRoot = resolve(mobileRoot, '..', '..');

const options = parseArgs(process.argv.slice(2));
const apiBase = normalizeBaseUrl(options.apiBase ?? process.env.XDT_MOBILE_E2E_API_BASE_URL ?? DEFAULT_API_BASE);
const deviceLinkApiBase = normalizeBaseUrl(
  options.deviceLinkBase
    ?? process.env.XDT_MOBILE_E2E_DEVICE_LINK_API_BASE_URL
    ?? process.env.EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL
    ?? deriveDeviceLinkApiBase(apiBase),
);
const hostDeviceId = options.hostDeviceId ?? 'mobile-e2e-reconnect-host';
const controllerDeviceId = options.controllerDeviceId ?? 'mobile-e2e-reconnect-controller';
const sessionId = options.sessionId ?? 'reconnect-session-1';
const waitForReadyMs = options.waitForReadyMs ?? (options.startServer ? 20_000 : 0);
const cleanupTasks = [];
let requestSeq = 0;

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

if (options.dryRun) {
  console.log('device-link-reconnect-smoke dry run');
  console.log(`- api base: ${apiBase}`);
  console.log(`- device-link api base: ${deviceLinkApiBase}`);
  console.log(`- host device id: ${hostDeviceId}`);
  console.log(`- controller device id: ${controllerDeviceId}`);
  console.log(`- session id: ${sessionId}`);
  console.log(`- start server: ${options.startServer ? 'yes' : 'no'}`);
  if (options.startServer) console.log('- server command: pnpm dev:server');
  process.exit(0);
}

const hostMessages = [
  message('m1', '2026-01-01T00:00:01.000Z'),
  message('m2', '2026-01-01T00:00:02.000Z'),
];

let host = null;
let controller = null;
let reconnected = null;

try {
  if (options.startServer) startServerProcess();
  await assertServerReady();

  host = await connectDevice(hostDeviceId, {
    deviceName: 'Reconnect Host',
    platform: 'darwin',
    appVersion: '0.0.0-reconnect-smoke',
    remoteControlEnabled: true,
    busy: false,
  }, handleHostFrame);

  controller = await connectDevice(controllerDeviceId, {
    deviceName: 'Reconnect Controller',
    platform: 'ios',
    appVersion: '0.0.0-reconnect-smoke',
    remoteControlEnabled: false,
    busy: false,
  });

  await openLink(controller, hostDeviceId);
  await invoke(controller, hostDeviceId, 'device-link:subscribe', [{ topics: ['sessions', `session:${sessionId}`] }]);
  const before = await invoke(controller, hostDeviceId, 'local-db:messages:list', [sessionId, { limit: 80 }]);
  assertMessageIds(before, ['m1', 'm2'], 'initial message list');

  const oldController = controller;
  oldController.ws.terminate();
  await waitForClose(oldController);

  hostMessages.push(
    message('m3', '2026-01-01T00:00:03.000Z'),
    message('m4', '2026-01-01T00:00:04.000Z'),
  );
  send(host.ws, {
    v: PROTOCOL_VERSION,
    kind: 'push',
    dst: controllerDeviceId,
    payload: { channel: 'local-db:messages:created', payload: { sessionId, message: hostMessages[2] } },
  });
  await sleep(150);

  reconnected = await connectDevice(controllerDeviceId, {
    deviceName: 'Reconnect Controller',
    platform: 'ios',
    appVersion: '0.0.0-reconnect-smoke',
    remoteControlEnabled: false,
    busy: false,
  });
  controller = reconnected;

  await openLink(controller, hostDeviceId);
  await invoke(controller, hostDeviceId, 'device-link:subscribe', [{ topics: ['sessions', `session:${sessionId}`] }]);
  const after = await invoke(controller, hostDeviceId, 'local-db:messages:list', [sessionId, { limit: 80 }]);
  assertMessageIds(after, ['m1', 'm2', 'm3', 'm4'], 'reconnected message list');

  const gotGapPush = reconnected.frames.some((frame) =>
    frame.kind === 'push'
    && frame.payload?.channel === 'local-db:messages:created'
    && frame.payload?.payload?.message?.id === 'm3',
  );
  if (gotGapPush) {
    throw new Error('Reconnect smoke failed: gap message arrived as push instead of host-authoritative resync');
  }

  console.log('device-link-reconnect-smoke passed: lost push recovered by host-authoritative message reload');
} finally {
  host?.close();
  controller?.close();
  if (controller !== reconnected) reconnected?.close();
  cleanup();
}

async function assertServerReady() {
  await waitForJson(`${apiBase}/api/health`, {
    label: 'server health',
    waitForReadyMs,
    hint: [
      'Start the local server with device-link enabled before running reconnect smoke:',
      '  XDT_DEV_AUTH_ENABLED=1 REDIS_URL=redis://127.0.0.1:6379 pnpm dev:server',
      'Or pass --start-server.',
    ].join('\n'),
  });
}

async function connectDevice(deviceId, hello, onFrame) {
  const login = await requestJson(`${apiBase}/api/auth/dev-login`, {
    label: `${deviceId} dev login`,
    method: 'POST',
    body: { deviceId },
  });
  const accessToken = login?.accessToken;
  if (!accessToken) throw new Error(`${deviceId} dev login did not return an accessToken`);

  const wsUrl = `${deviceLinkApiBase.replace(/^http/, 'ws')}/api/device-link/ws`;
  const ws = new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const frames = [];
  const waiters = [];

  ws.on('open', () => {
    send(ws, { v: PROTOCOL_VERSION, kind: 'hello', payload: hello });
  });
  ws.on('message', (raw) => {
    const frame = JSON.parse(String(raw));
    frames.push(frame);
    if (frame.kind === 'ping') {
      send(ws, { v: PROTOCOL_VERSION, kind: 'pong' });
    }
    onFrame?.(frame, ws);
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index];
      if (waiter.predicate(frame)) {
        waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
    }
  });

  await waitForFrame(waiters, (frame) => frame.kind === 'hello-ack', `${deviceId} hello-ack`);

  return {
    accessToken,
    deviceId,
    frames,
    ws,
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'reconnect smoke cleanup');
      }
      void requestJson(`${apiBase}/api/auth/logout`, {
        label: `${deviceId} logout`,
        method: 'POST',
        token: accessToken,
        body: { deviceId },
        optional: true,
      });
    },
    nextFrame(predicate, label) {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return waitForFrame(waiters, predicate, label);
    },
  };
}

function handleHostFrame(frame, ws) {
  if (frame.kind === 'link-open') {
    send(ws, {
      v: PROTOCOL_VERSION,
      kind: 'link-accept',
      id: frame.id,
      dst: frame.src,
      payload: { appVersion: '0.0.0-reconnect-smoke', allowlistHash: 'reconnect-smoke' },
    });
    return;
  }
  if (frame.kind !== 'invoke') return;
  const channel = frame.payload?.channel;
  const args = Array.isArray(frame.payload?.args) ? frame.payload.args : [];
  let result;
  if (channel === 'device-link:subscribe' || channel === 'device-link:unsubscribe') {
    result = { ok: true };
  } else if (channel === 'local-db:messages:list') {
    result = listMessages(String(args[0] ?? sessionId), args[1]);
  } else {
    send(ws, {
      v: PROTOCOL_VERSION,
      kind: 'invoke-result',
      id: frame.id,
      dst: frame.src,
      payload: { ok: false, error: { code: 'CHANNEL_NOT_ALLOWED', message: String(channel) } },
    });
    return;
  }
  send(ws, {
    v: PROTOCOL_VERSION,
    kind: 'invoke-result',
    id: frame.id,
    dst: frame.src,
    payload: { ok: true, result },
  });
}

function listMessages(id, opts = {}) {
  if (id !== sessionId) return [];
  const limit = Number.isFinite(opts?.limit) ? Math.max(1, Math.floor(opts.limit)) : 80;
  return hostMessages.slice(-limit);
}

async function openLink(client, dst) {
  const id = requestId('link');
  const accepted = client.nextFrame((frame) => frame.kind === 'link-accept' && frame.id === id, 'link-accept');
  send(client.ws, {
    v: PROTOCOL_VERSION,
    kind: 'link-open',
    id,
    dst,
    payload: { controllerName: 'Reconnect Smoke', protocolVersion: PROTOCOL_VERSION },
  });
  await accepted;
}

async function invoke(client, dst, channel, args) {
  const id = requestId('invoke');
  const result = client.nextFrame((item) => item.kind === 'invoke-result' && item.id === id, channel);
  send(client.ws, {
    v: PROTOCOL_VERSION,
    kind: 'invoke',
    id,
    dst,
    payload: { channel, args },
  });
  const frame = await result;
  if (!frame.payload?.ok) {
    throw new Error(`${channel} failed: ${frame.payload?.error?.message ?? 'unknown error'}`);
  }
  return frame.payload.result;
}

function assertMessageIds(messages, expected, label) {
  const actual = Array.isArray(messages) ? messages.map((item) => item.id) : [];
  if (actual.join(',') !== expected.join(',')) {
    throw new Error(`${label} expected ${expected.join(',')} but got ${actual.join(',')}`);
  }
}

function waitForFrame(waiters, predicate, label, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
    waiters.push({ predicate, resolve, timer });
  });
}

function waitForClose(device, timeoutMs = 5_000) {
  if (device.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${device.deviceId} close`)), timeoutMs);
    device.ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const headers = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(`${options.label ?? url} returned ${response.status}: ${text}`);
    return parsed;
  } catch (err) {
    if (options.optional) return null;
    const suffix = options.hint ? `\n${options.hint}` : '';
    throw new Error(`${options.label ?? url} failed: ${err instanceof Error ? err.message : String(err)}${suffix}`);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForJson(url, options = {}) {
  const deadline = Date.now() + (options.waitForReadyMs ?? 0);
  let lastError = null;
  do {
    try {
      return await requestJson(url, options);
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) break;
    await sleep(500);
  } while (true);
  throw lastError;
}

function message(id, createdAt) {
  return {
    id,
    clientId: id,
    sessionId,
    role: 'assistant',
    content: id,
    toolUseId: null,
    agentMeta: null,
    createdAt,
  };
}

function send(ws, frame) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(frame));
}

function requestId(prefix) {
  requestSeq += 1;
  return `${prefix}-${requestSeq}`;
}

function parseArgs(args) {
  const parsed = {
    startServer: false,
    waitForReadyMs: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--start-server') {
      parsed.startServer = true;
      continue;
    }
    if (arg === '--api-base') {
      parsed.apiBase = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--device-link-base') {
      parsed.deviceLinkBase = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--host-device-id') {
      parsed.hostDeviceId = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--controller-device-id') {
      parsed.controllerDeviceId = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--session-id') {
      parsed.sessionId = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--wait-for-ready-ms') {
      const raw = readValue(args, index, arg);
      const parsedValue = Number(raw);
      if (!Number.isFinite(parsedValue) || parsedValue < 0) {
        throw new Error(`${arg} requires a non-negative number`);
      }
      parsed.waitForReadyMs = parsedValue;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

function readValue(args, index, flag) {
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function normalizeBaseUrl(value) {
  return value.trim().replace(/\/$/, '');
}

// deriveDeviceLinkApiBase 收敛至共享 lib(仅本地 3333→3335 端口推导;生产域名分支已随 apiBaseUrl 退役删除)
import { deriveDeviceLinkApiBase } from './lib/device-link-base.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServerProcess() {
  const child = spawn(pnpmBin(), ['dev:server'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      XDT_DEV_AUTH_ENABLED: process.env.XDT_DEV_AUTH_ENABLED ?? '1',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeChildOutput(child, 'server');
  const cleanupTask = () => stopChild(child);
  cleanupTasks.push(cleanupTask);
  console.log('device-link-reconnect-smoke started local server fixture');
}

function pipeChildOutput(child, label) {
  child.stdout?.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      console.log(`[${label}] ${line}`);
    }
  });
  child.stderr?.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      console.error(`[${label}] ${line}`);
    }
  });
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, 2_000).unref();
}

function cleanup() {
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop();
    try {
      task?.();
    } catch {
      // best effort
    }
  }
}

function pnpmBin() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}
