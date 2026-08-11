import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';

import TOML from '@iarna/toml';
import express from 'express';

type ProviderJson = { id: string; baseUrl?: string; model?: string; wireApi?: string; apiKey?: string; discoveredModels?: string[]; modelDiscoveryError?: string; modelDiscovery?: { modelCount?: number; httpStatus?: number; latencyMs?: number; lastSuccessAt?: string; lastErrorAt?: string | null } };
type PresetJson = { id: string; target: string; wireApi: string; [key: string]: unknown };
type ProbeResultJson = { usable?: boolean; [key: string]: unknown };
type ApiJson = {
  activeByTarget: Record<string, string>;
  nativeAvailableByTarget: Record<string, boolean>;
  providers: ProviderJson[];
  presets: PresetJson[];
  targets: Record<string, { files: Array<{ path: string }> }>;
  backups: Array<{
    relativePath: string;
    targetPath: string | null;
    targetId: string | null;
    targetLabel: string;
    fileName: string;
    createdAt: string;
    size: number;
  }>;
  imported: ProviderJson[];
  results: ProbeResultJson[];
  models: string[];
  discovery?: string;
  warning?: unknown;
  successCount?: number;
  averageLatencyMs?: number;
  selectedBaseUrl?: string;
  [key: string]: unknown;
};
type ReceivedProbe = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string };
const readApiJson = (response: globalThis.Response): Promise<ApiJson> => response.json() as Promise<ApiJson>;


test('provider switch preserves Codex top-level semantics and serializes concurrent saves', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'leocodebox-switch-test-'));
  process.env.LEOCODEBOX_TEST_HOME = home;
  process.env.LEOCODEBOX_LOCAL_ONLY = '1';

  const codexDir = path.join(home, '.codex');
  await fs.mkdir(codexDir, { recursive: true });
  await fs.writeFile(path.join(codexDir, 'auth.json'), JSON.stringify({
    OPENAI_API_KEY: 'old-key',
    tokens: { access_token: 'keep-token' },
  }));
  await fs.writeFile(path.join(codexDir, 'config.toml'), [
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    '',
    '[features]',
    'web_search = true',
    '',
    '[profiles.leocodebox]',
    'model = "user-profile-model"',
    '',
  ].join('\n'));

  const { default: router } = await import('../../modules/leocodebox/leocodebox.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/leocodebox', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(home, { recursive: true, force: true });
  });

  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}/api/leocodebox`;
  const post = async (url: string, body: unknown): Promise<ApiJson> => {
    const response = await fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    return JSON.parse(responseText) as ApiJson;
  };

  await post('/switch/providers', {
    id: 'official',
    target: 'codex',
    name: 'Official OAuth',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-5.5',
    wireApi: 'responses',
  });
  await post('/switch/providers/official/apply', {});

  let activeStatus = await fetch(`${base}/switch/status`).then(readApiJson);
  assert.equal(activeStatus.activeByTarget.codex, 'official');

  const config = TOML.parse(await fs.readFile(path.join(codexDir, 'config.toml'), 'utf8')) as Record<string, unknown> & { profiles: { leocodebox: { model: string } } };
  assert.equal(config.approval_policy, 'on-request');
  assert.equal(config.sandbox_mode, 'workspace-write');
  assert.deepEqual(config.features, { web_search: true });
  assert.equal(config.model, 'gpt-5.5');
  assert.equal(config.profiles.leocodebox.model, 'user-profile-model');

  const auth = JSON.parse(await fs.readFile(path.join(codexDir, 'auth.json'), 'utf8'));
  assert.equal(Object.hasOwn(auth, 'OPENAI_API_KEY'), false);
  assert.equal(auth.tokens.access_token, 'keep-token');

  await Promise.all(Array.from({ length: 20 }, (_, index) => post('/switch/providers', {
    id: `parallel-${index}`,
    target: 'claude',
    name: `Parallel ${index}`,
  })));
  const status = await fetch(`${base}/switch/status`).then(readApiJson);
  assert.equal(status.providers.filter((provider) => provider.id.startsWith('parallel-')).length, 20);
  assert.ok(status.presets.length > 0);
  for (const preset of status.presets) {
    assert.equal(typeof preset.id, 'string');
    assert.ok(preset.id.length > 0);
    assert.ok(['claude', 'codex', 'opencode', 'cursor', 'gemini', 'hermes'].includes(preset.target));
    assert.ok(['responses', 'chat', 'messages', 'gemini'].includes(preset.wireApi));
  }
  assert.deepEqual(
    status.presets.find((preset) => preset.id === 'xai'),
    {
      id: 'xai',
      name: 'xAI / Grok',
      vendor: 'xAI',
      target: 'codex',
      baseUrl: 'https://api.x.ai/v1',
      defaultModel: '',
      wireApi: 'chat',
      status: 'beta',
      docsUrl: 'https://console.x.ai/',
    },
  );

  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    theme: 'dark',
    env: { KEEP_ME: 'yes' },
  }));
  await post('/switch/providers', {
    id: 'claude-proxy',
    target: 'claude',
    name: 'Claude Proxy',
    baseUrl: 'https://claude.example.test',
    apiKey: 'claude-key',
    model: 'claude-sonnet-test',
    modelMapping: {
      sonnet: 'claude-sonnet-test',
      opus: 'claude-opus-test',
      haiku: 'claude-haiku-test',
    },
  });
  await post('/switch/providers/claude-proxy/apply', {});
  activeStatus = await fetch(`${base}/switch/status`).then(readApiJson);
  assert.equal(activeStatus.activeByTarget.claude, 'claude-proxy');
  const claudeSettings = JSON.parse(await fs.readFile(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claudeSettings.theme, 'dark');
  assert.equal(claudeSettings.env.KEEP_ME, 'yes');
  assert.equal(claudeSettings.env.ANTHROPIC_BASE_URL, 'https://claude.example.test');
  assert.equal(claudeSettings.env.ANTHROPIC_AUTH_TOKEN, 'claude-key');
  assert.equal(claudeSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-test');
  assert.equal(claudeSettings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-test');
  assert.equal(claudeSettings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-haiku-test');

  await fs.mkdir(path.join(home, '.config', 'opencode'), { recursive: true });
  await fs.writeFile(path.join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({
    plugin: ['keep-plugin'],
  }));
  await post('/switch/providers', {
    id: 'opencode-proxy',
    target: 'opencode',
    name: 'OpenCode Proxy',
    baseUrl: 'https://open.example.test/v1',
    apiKey: 'open-key',
    model: 'open-model',
  });
  await post('/switch/providers/opencode-proxy/apply', {});
  activeStatus = await fetch(`${base}/switch/status`).then(readApiJson);
  assert.equal(activeStatus.activeByTarget.opencode, 'opencode-proxy');
  const opencodeConfig = JSON.parse(await fs.readFile(path.join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.deepEqual(opencodeConfig.plugin, ['keep-plugin']);
  assert.equal(opencodeConfig.model, 'leocodebox_opencode-proxy/open-model');
  assert.equal(opencodeConfig.provider['leocodebox_opencode-proxy'].options.apiKey, 'open-key');

  assert.equal(activeStatus.nativeAvailableByTarget.opencode, true);
  await post('/switch/targets/opencode/restore-default', {});
  const restoredOpenCodeConfig = JSON.parse(await fs.readFile(path.join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.deepEqual(restoredOpenCodeConfig, { plugin: ['keep-plugin'] });
  activeStatus = await fetch(`${base}/switch/status`).then(readApiJson);
  assert.equal(activeStatus.activeByTarget.opencode, undefined);

  await fs.mkdir(path.join(home, '.gemini'), { recursive: true });
  const originalGeminiEnv = [
    '# Preserve this comment',
    'export OTHER_TOKEN="hello world"',
    'lower_case=value',
    'KEEP_ME=yes # inline comment',
    '',
  ].join('\n');
  await fs.writeFile(path.join(home, '.gemini', '.env'), originalGeminiEnv);
  await post('/switch/providers', {
    id: 'gemini-proxy',
    target: 'gemini',
    name: 'Gemini Proxy',
    baseUrl: 'https://gemini.example.test',
    apiKey: 'gemini-key',
    model: 'gemini-test',
  });
  await post('/switch/providers/gemini-proxy/apply', {});
  const geminiEnv = await fs.readFile(path.join(home, '.gemini', '.env'), 'utf8');
  assert.match(geminiEnv, /^# Preserve this comment$/m);
  assert.match(geminiEnv, /^export OTHER_TOKEN="hello world"$/m);
  assert.match(geminiEnv, /^lower_case=value$/m);
  assert.match(geminiEnv, /^KEEP_ME=yes # inline comment$/m);
  assert.match(geminiEnv, /^GEMINI_API_KEY=gemini-key$/m);
  assert.match(geminiEnv, /^GEMINI_MODEL=gemini-test$/m);

  await post('/switch/providers', {
    id: 'gemini-clean',
    target: 'gemini',
    name: 'Gemini without overrides',
    baseUrl: '',
    apiKey: '',
    model: '',
  });
  await post('/switch/providers/gemini-clean/apply', {});
  const cleanedGeminiEnv = await fs.readFile(path.join(home, '.gemini', '.env'), 'utf8');
  assert.match(cleanedGeminiEnv, /^# Preserve this comment$/m);
  assert.match(cleanedGeminiEnv, /^export OTHER_TOKEN="hello world"$/m);
  assert.match(cleanedGeminiEnv, /^lower_case=value$/m);
  assert.match(cleanedGeminiEnv, /^KEEP_ME=yes # inline comment$/m);
  assert.doesNotMatch(
    cleanedGeminiEnv,
    /^(?:GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GEMINI_BASE_URL|GEMINI_MODEL)=/m,
  );

  process.env.CLAUDE_CONFIG_DIR = '~/custom-claude';
  process.env.CODEX_HOME = '~/custom-codex';
  process.env.XDG_CONFIG_HOME = '~/custom-xdg';
  t.after(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    delete process.env.XDG_CONFIG_HOME;
  });
  await post('/switch/providers', {
    id: 'custom-path-claude',
    target: 'claude',
    name: 'Custom-path Claude',
    apiKey: 'custom-key',
  });
  await post('/switch/providers/custom-path-claude/apply', {});
  const customClaudeSettings = JSON.parse(
    await fs.readFile(path.join(home, 'custom-claude', 'settings.json'), 'utf8'),
  );
  assert.equal(customClaudeSettings.env.ANTHROPIC_API_KEY, 'custom-key');
  const customPathStatus = await fetch(`${base}/switch/status`).then(readApiJson);
  assert.equal(customPathStatus.targets.claude.files[0].path, '~/custom-claude/settings.json');
  assert.equal(customPathStatus.targets.codex.files[0].path, '~/custom-codex/auth.json');
  assert.equal(customPathStatus.targets.opencode.files[0].path, '~/custom-xdg/opencode/opencode.json');

  const externalCodexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'leocodebox-external-codex-'));
  t.after(() => fs.rm(externalCodexHome, { recursive: true, force: true }));
  process.env.CODEX_HOME = externalCodexHome;
  const externalAuthPath = path.join(externalCodexHome, 'auth.json');
  const externalConfigPath = path.join(externalCodexHome, 'config.toml');
  await fs.writeFile(externalAuthPath, JSON.stringify({ OPENAI_API_KEY: 'before-restore' }));
  await fs.writeFile(externalConfigPath, 'approval_policy = "on-request"\n');
  await post('/switch/providers', {
    id: 'external-codex',
    target: 'codex',
    name: 'External Codex',
    apiKey: 'after-apply',
    model: 'external-model',
  });
  await post('/switch/providers/external-codex/apply', {});
  const externalBackups = await fetch(`${base}/switch/backups`).then(readApiJson);
  const externalAuthBackup = externalBackups.backups.find((entry) => entry.targetPath === externalAuthPath);
  assert.ok(externalAuthBackup, 'external CODEX_HOME backup should retain its absolute destination');
  await fs.writeFile(externalAuthPath, JSON.stringify({ OPENAI_API_KEY: 'modified-after-apply' }));
  await post('/switch/backups/restore', { relativePath: externalAuthBackup.relativePath });
  assert.equal(JSON.parse(await fs.readFile(externalAuthPath, 'utf8')).OPENAI_API_KEY, 'before-restore');

  await fs.mkdir(path.join(home, '.hermes'), { recursive: true });
  await fs.writeFile(path.join(home, '.hermes', 'config.yaml'), 'telemetry: false\n');
  await post('/switch/providers', {
    id: 'hermes-proxy',
    target: 'hermes',
    name: 'Hermes Proxy',
    baseUrl: 'https://hermes.example.test/v1',
    apiKey: 'hermes-key',
    model: 'hermes-test',
  });
  await post('/switch/providers/hermes-proxy/apply', {});
  const hermesConfig = await fs.readFile(path.join(home, '.hermes', 'config.yaml'), 'utf8');
  assert.match(hermesConfig, /^telemetry: false$/m);
  assert.match(hermesConfig, /# BEGIN LEOCODEBOX SWITCH/);
  assert.match(hermesConfig, /api_key: "hermes-key"/);

  const backups = await fetch(`${base}/switch/backups`).then(readApiJson);
  assert.ok(backups.backups.some((entry) => entry.relativePath.endsWith('.claude/settings.json')));
  for (const backup of backups.backups) {
    assert.ok(backup.targetLabel.length > 0);
    assert.ok(backup.fileName.length > 0);
    assert.ok(Number.isFinite(Date.parse(backup.createdAt)));
    assert.ok(backup.size >= 0);
  }

  if (process.platform !== 'win32') {
    const switchMode = (await fs.stat(path.join(home, '.leocodebox', 'switch'))).mode & 0o777;
    const storeMode = (await fs.stat(path.join(home, '.leocodebox', 'switch', 'providers.json'))).mode & 0o777;
    assert.equal(switchMode, 0o700);
    assert.equal(storeMode, 0o600);

    for (const backup of backups.backups) {
      const backupMode = (await fs.stat(path.join(home, '.leocodebox', 'switch', 'backups', backup.relativePath))).mode & 0o777;
      assert.equal(backupMode, 0o600);
    }
  }

  const traversalResponse = await fetch(`${base}/switch/backups/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath: '../outside' }),
  });
  assert.equal(traversalResponse.status, 400);

  const receivedProbes: ReceivedProbe[] = [];
  const slowProbeRelease: { current?: () => void } = {};
  const releaseCurrentSlowProbe = (): void => slowProbeRelease.current?.();
  const probeServer = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      receivedProbes.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (request.url === '/slow/v1/models') {
        slowProbeRelease.current = () => {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ data: [{ id: 'slow-model' }] }));
        };
        return;
      }
      if (request.url === '/unauthorized/v1/models') {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'invalid API key' } }));
        return;
      }
      response.writeHead(request.url === '/v1/messages' ? 400 : 200, { 'Content-Type': 'application/json' });
      response.end(request.url === '/v1/models' || request.url === '/second/v1/models'
        ? JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] })
        : '{}');
    });
  });
  probeServer.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => probeServer.once('listening', resolve));
  t.after(() => new Promise<void>((resolve, reject) => probeServer.close((error) => error ? reject(error) : resolve())));
  const probeAddress = probeServer.address() as AddressInfo;
  const probeBaseUrl = `http://127.0.0.1:${probeAddress.port}`;

  const asyncSave = await post('/switch/providers', {
    id: 'async-discovery',
    target: 'codex',
    name: 'Async Discovery',
    baseUrl: `${probeBaseUrl}/slow/v1`,
    apiKey: 'slow-key',
    autoDiscover: true,
    timeoutMs: 4000,
  });
  assert.equal(asyncSave.discovery, 'pending');
  await post('/switch/providers', { id: 'save-while-discovering', target: 'claude', name: 'Not Blocked' });
  for (let attempt = 0; attempt < 20 && !slowProbeRelease.current; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(slowProbeRelease.current, 'background discovery should start after the save response');
  releaseCurrentSlowProbe();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const discoveryStatus = await fetch(`${base}/switch/status`).then(readApiJson);
    const provider = discoveryStatus.providers.find((item) => item.id === 'async-discovery');
    if (provider?.discoveredModels?.includes('slow-model')) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const asyncStatus = await fetch(`${base}/switch/status`).then(readApiJson);
  assert.deepEqual(asyncStatus.providers.find((item) => item.id === 'async-discovery')!.discoveredModels, ['slow-model']);

  slowProbeRelease.current = undefined;
  await post('/switch/providers', {
    id: 'dedupe-probe',
    target: 'codex',
    name: 'Dedupe Probe',
    baseUrl: `${probeBaseUrl}/slow/v1`,
    apiKey: 'dedupe-key',
  });
  const slowProbeCountBefore = receivedProbes.filter((probe) => probe.url === '/slow/v1/models').length;
  const firstPendingDiscovery = post('/switch/providers/dedupe-probe/models', { timeoutMs: 4000 });
  const secondPendingDiscovery = post('/switch/providers/dedupe-probe/models', { timeoutMs: 4000 });
  for (let attempt = 0; attempt < 20 && !slowProbeRelease.current; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(slowProbeRelease.current, 'concurrent discoveries should share one upstream request');
  releaseCurrentSlowProbe();
  const [firstDedupeResult, secondDedupeResult] = await Promise.all([firstPendingDiscovery, secondPendingDiscovery]);
  assert.deepEqual(firstDedupeResult.models, ['slow-model']);
  assert.deepEqual(secondDedupeResult.models, ['slow-model']);
  assert.equal(receivedProbes.filter((probe) => probe.url === '/slow/v1/models').length, slowProbeCountBefore + 1);

  await post('/switch/providers', {
    id: 'claude-probe',
    target: 'claude',
    name: 'Claude Probe',
    baseUrl: probeBaseUrl,
    apiKey: 'probe-key',
    model: 'probe-model',
  });
  const claudeProbe = await post('/switch/providers/claude-probe/test', {});
  assert.equal(claudeProbe.reachable, true);
  assert.equal(claudeProbe.httpStatus, 400);
  assert.equal(claudeProbe.authStatus, 'accepted');
  const claudeRequest = receivedProbes.find((probe) => probe.method === 'POST' && probe.url === '/v1/messages');
  assert.ok(claudeRequest);
  assert.equal(claudeRequest.headers['x-api-key'], 'probe-key');
  assert.equal(JSON.parse(claudeRequest.body).max_tokens, 1);

  await post('/switch/providers', {
    id: 'codex-probe',
    target: 'codex',
    name: 'Codex Probe',
    baseUrl: `${probeBaseUrl}/v1`,
    apiKey: 'codex-key',
  });
  const codexProbe = await post('/switch/providers/codex-probe/test', {});
  assert.equal(codexProbe.reachable, true);
  assert.equal(codexProbe.httpStatus, 200);
  assert.equal(codexProbe.authStatus, 'accepted');
  const codexRequest = receivedProbes.find((probe) => probe.method === 'GET' && probe.url === '/v1/models' && probe.headers.authorization === 'Bearer codex-key');
  assert.ok(codexRequest);

  const discoveredModels = await post('/switch/providers/codex-probe/models', { timeoutMs: 4000 });
  assert.deepEqual(discoveredModels.models, ['model-a', 'model-b']);
  assert.equal(discoveredModels.httpStatus, 200);
  const healthStatus = await fetch(`${base}/switch/status`).then(readApiJson);
  const healthyProvider = healthStatus.providers.find((item) => item.id === 'codex-probe');
  assert.equal(healthyProvider!.modelDiscovery!.modelCount, 2);
  assert.equal(healthyProvider!.modelDiscovery!.httpStatus, 200);
  assert.equal(Number.isFinite(healthyProvider!.modelDiscovery!.latencyMs), true);
  assert.equal(typeof healthyProvider!.modelDiscovery!.lastSuccessAt, 'string');
  assert.equal(healthyProvider!.modelDiscovery!.lastErrorAt, null);

  const failedDiscoverySave = await post('/switch/providers', {
    id: 'failed-discovery',
    target: 'codex',
    name: 'Failed Discovery',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'failed-key',
    autoDiscover: true,
    timeoutMs: 1000,
  });
  assert.equal(failedDiscoverySave.discovery, 'pending');
  let failedProvider: ProviderJson | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const failedStatus = await fetch(`${base}/switch/status`).then(readApiJson);
    failedProvider = failedStatus.providers.find((item) => item.id === 'failed-discovery');
    if (failedProvider?.modelDiscoveryError) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(typeof failedProvider!.modelDiscoveryError, 'string');
  assert.ok((failedProvider!.modelDiscoveryError ?? '').length > 0);
  assert.equal(typeof failedProvider!.modelDiscovery!.lastErrorAt, 'string');

  const destinationChangeWithStoredKey = await fetch(`${base}/switch/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'codex-probe',
      target: 'codex',
      name: 'Codex Probe',
      baseUrl: 'http://127.0.0.1:1/exfiltrate',
      apiKey: '__KEEP__',
      wireApi: 'chat',
      autoDiscover: true,
    }),
  });
  assert.equal(destinationChangeWithStoredKey.status, 400);

  const storedKeyDraftOverride = await fetch(`${base}/switch/discover-models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId: 'codex-probe',
      target: 'codex',
      baseUrl: 'http://127.0.0.1:1/exfiltrate',
      wireApi: 'chat',
      useStoredKey: true,
    }),
  });
  assert.equal(storedKeyDraftOverride.status, 400);

  const storedKeyDraft = await post('/switch/discover-models', {
    providerId: 'codex-probe',
    target: 'codex',
    baseUrl: `${probeBaseUrl}/v1`,
    wireApi: 'responses',
    useStoredKey: true,
    bypassCache: true,
  });
  assert.deepEqual(storedKeyDraft.models, ['model-a', 'model-b']);

  const newEndpointWithStoredKey = await fetch(`${base}/switch/providers/codex-probe/endpoints/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoints: ['http://127.0.0.1:1/exfiltrate'] }),
  });
  assert.equal(newEndpointWithStoredKey.status, 400);

  const probeCountBeforeOverrideAttempt = receivedProbes.length;
  const ignoredOverride = await post('/switch/providers/codex-probe/models', {
    timeoutMs: 4000,
    baseUrl: 'http://127.0.0.1:1/credential-exfiltration',
    apiKey: 'attacker-controlled-key',
  });
  assert.deepEqual(ignoredOverride.models, ['model-a', 'model-b']);
  assert.equal(receivedProbes.length, probeCountBeforeOverrideAttempt + 1);
  assert.equal(receivedProbes.at(-1)!.url, '/v1/models');
  assert.equal(receivedProbes.at(-1)!.headers.authorization, 'Bearer codex-key');

  const unauthorizedDiscovery = await fetch(`${base}/switch/discover-models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target: 'codex',
      baseUrl: `${probeBaseUrl}/unauthorized/v1`,
      apiKey: 'rejected-key',
      bypassCache: true,
    }),
  });
  assert.equal(unauthorizedDiscovery.status, 401);

  for (const invalidBaseUrl of ['file:///tmp/models.json', 'not a url']) {
    const response = await fetch(`${base}/switch/discover-models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'codex', baseUrl: invalidBaseUrl, apiKey: 'draft-key' }),
    });
    assert.equal(response.status, 400);
  }

  const cachePath = path.join(home, '.leocodebox', 'switch', 'model-discovery-cache.json');
  const existingCache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  existingCache.entries['preserved-disk-only-entry'] = {
    updatedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    result: { models: ['preserved-model'], latencyMs: 1, httpStatus: 200, endpoint: 'https://preserved.example/v1' },
  };
  existingCache.entries['expired-disk-entry'] = {
    updatedAt: Date.now() - 120_000,
    expiresAt: Date.now() - 60_000,
    result: { models: ['expired-model'], latencyMs: 1, httpStatus: 200, endpoint: 'https://expired.example/v1' },
  };
  await fs.writeFile(cachePath, JSON.stringify(existingCache));
  await post('/switch/providers', {
    id: 'second-cache-probe',
    target: 'codex',
    name: 'Second Cache Probe',
    baseUrl: `${probeBaseUrl}/second/v1`,
    apiKey: 'second-key',
  });
  await post('/switch/providers/second-cache-probe/models', { timeoutMs: 4000 });
  const mergedCache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  assert.equal(mergedCache.version, 2);
  assert.ok(mergedCache.entries['preserved-disk-only-entry']);
  assert.equal(Object.hasOwn(mergedCache.entries, 'expired-disk-entry'), false);
  assert.ok(Object.keys(mergedCache.entries).length >= 3);

  const benchmark = await post('/switch/providers/codex-probe/benchmark', {
    model: 'model-a',
    attempts: 2,
    timeoutMs: 4000,
  });
  assert.equal(benchmark.successCount, 2);
  assert.equal(benchmark.results.length, 2);
  assert.ok((benchmark.averageLatencyMs ?? -1) >= 0);

  await post('/switch/providers', {
    id: 'codex-probe',
    endpoints: [`${probeBaseUrl}/v1`],
    autoSelectEndpoint: true,
    apiKey: '__KEEP__',
  });
  const endpointTest = await post('/switch/providers/codex-probe/endpoints/test', {
    timeoutMs: 4000,
    autoSelectEndpoint: true,
  });
  assert.equal(endpointTest.results.length, 1);
  assert.equal(endpointTest.results[0].usable, true);
  assert.equal(endpointTest.selectedBaseUrl, `${probeBaseUrl}/v1`);

  await fs.writeFile(externalAuthPath, JSON.stringify({ OPENAI_API_KEY: 'active-codex-key' }));
  await fs.writeFile(externalConfigPath, [
    'model = "active-codex-model"',
    'model_provider = "second"',
    '',
    '[model_providers.first]',
    'base_url = "https://wrong-codex.example/v1"',
    'wire_api = "responses"',
    '',
    '[model_providers.second]',
    'base_url = "https://active-codex.example/v1"',
    'wire_api = "chat"',
    '',
  ].join('\n'));
  const customOpenCodePath = path.join(home, 'custom-xdg', 'opencode', 'opencode.json');
  await fs.mkdir(path.dirname(customOpenCodePath), { recursive: true });
  await fs.writeFile(customOpenCodePath, JSON.stringify({
    model: 'second/active-opencode-model',
    provider: {
      first: { options: { baseURL: 'https://wrong-opencode.example/v1', apiKey: 'wrong-key' } },
      second: { options: { baseURL: 'https://active-opencode.example/v1', apiKey: 'active-key' } },
    },
  }));
  const importedCurrent = await post('/switch/import-current', {});
  assert.ok(importedCurrent.imported.some((provider) => provider.id === 'codex-current'));
  assert.ok(importedCurrent.imported.some((provider) => provider.id === 'opencode-current'));
  const importedStatus = await fetch(`${base}/switch/status`).then(readApiJson);
  const importedCodex = importedStatus.providers.find((provider) => provider.id === 'codex-current');
  assert.equal(importedCodex!.baseUrl, 'https://active-codex.example/v1');
  assert.equal(importedCodex!.model, 'active-codex-model');
  assert.equal(importedCodex!.wireApi, 'chat');
  const importedOpenCode = importedStatus.providers.find((provider) => provider.id === 'opencode-current');
  assert.equal(importedOpenCode!.baseUrl, 'https://active-opencode.example/v1');
  assert.match(importedOpenCode!.apiKey ?? '', /^acti.*-key$/);
  assert.equal(importedOpenCode!.model, 'active-opencode-model');
});
