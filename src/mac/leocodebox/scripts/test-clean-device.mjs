import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import electronPath from 'electron';

const appRoot = process.cwd();
const expectedAppVersion = JSON.parse(await fs.readFile(path.join(appRoot, 'package.json'), 'utf8')).version;
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'leocodebox-clean-device-'));
const fakeBin = path.join(tempHome, '.local', 'bin');
const electronUserData = path.join(tempHome, 'Library', 'Application Support', 'leocodebox-clean-device');
const markerPath = path.join(tempHome, '.leocodebox', 'local-server.json');
const expectedTools = new Map([
  ['claude', '9.1.1'],
  ['codex', '9.2.2'],
  ['opencode', '9.3.3'],
  ['cursor-agent', '9.4.4'],
  ['gemini', '9.5.5'],
  ['hermes', '9.6.6'],
  ['grok', '0.2.93'],
]);

await fs.mkdir(fakeBin, { recursive: true });
for (const [command, version] of expectedTools) {
  await fs.writeFile(
    path.join(fakeBin, command),
    `#!/bin/sh\necho "${command} ${version}"\n`,
    { mode: 0o755 },
  );
}

const desktop = spawn(electronPath, [
  `--user-data-dir=${electronUserData}`,
  path.join(appRoot, 'electron', 'main.js'),
], {
  cwd: appRoot,
  env: {
    HOME: tempHome,
    USER: 'clean-device',
    LOGNAME: 'clean-device',
    SHELL: '/bin/zsh',
    PATH: '/usr/bin:/bin',
    TMPDIR: os.tmpdir(),
    LEOCODEBOX_AGENT_PATH: fakeBin,
    LEOCODEBOX_DESKTOP_DEFAULT_PORT: '38473',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
desktop.stdout.on('data', (chunk) => { output += chunk.toString(); });
desktop.stderr.on('data', (chunk) => { output += chunk.toString(); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(getValue, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await getValue();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError || new Error(`Timed out after ${timeoutMs} ms.`);
}

async function readMarker() {
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  const healthResponse = await fetch(`${marker.url}/health`);
  if (!healthResponse.ok) return null;
  return { marker, health: await healthResponse.json() };
}

function readLocalToken(serverPid) {
  const processDetails = execFileSync('/bin/ps', ['eww', '-p', String(serverPid)], { encoding: 'utf8' });
  const match = processDetails.match(/(?:^|\s)LEOCODEBOX_LOCAL_AUTH_TOKEN=([^\s]+)/);
  return match?.[1] || '';
}

async function fetchJson(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.text();
  assert.equal(response.ok, true, `${response.status} ${body}`);
  return JSON.parse(body);
}

let marker = null;
try {
  const ready = await waitFor(readMarker);
  marker = ready.marker;
  assert.equal(ready.health.status, 'ok');
  assert.equal(ready.health.version, expectedAppVersion);

  const token = await waitFor(async () => readLocalToken(marker.pid));
  const authStatus = await fetchJson(`${marker.url}/api/auth/status`, token);
  assert.equal(authStatus.localOnly, true);
  assert.equal(authStatus.needsSetup, false);
  assert.equal(authStatus.isAuthenticated, true);
  assert.equal(authStatus.user.username, 'local-agent');

  const cliStatus = await fetchJson(`${marker.url}/api/leocodebox/cli/status`, token);
  assert.equal(cliStatus.tools.length, 7);
  for (const tool of cliStatus.tools) {
    const command = tool.id === 'cursor' ? 'cursor-agent' : tool.id;
    assert.equal(tool.installed, true, `${tool.label} was not discovered`);
    assert.equal(tool.runnable, true, `${tool.label} was not runnable`);
    assert.equal(tool.currentVersion, expectedTools.get(command));
  }

  const switchStatus = await fetchJson(`${marker.url}/api/leocodebox/switch/status`, token);
  assert.equal(switchStatus.providers.length, 0);
  assert.equal(Object.keys(switchStatus.targets).length, 6);

  await fetchJson(`${marker.url}/api/projects`, token);
  process.stdout.write('Clean-device smoke test passed: no login, seven local agent CLIs discovered, empty local state handled.\n');
} catch (error) {
  throw new Error(`${error.message}\nRecent desktop output:\n${output.slice(-6000)}`);
} finally {
  desktop.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => desktop.once('exit', resolve)),
    sleep(5000),
  ]);
  if (marker?.pid) {
    try {
      process.kill(marker.pid, 'SIGTERM');
    } catch {
      // The desktop app already stopped its owned server.
    }
  }
  await fs.rm(tempHome, { recursive: true, force: true });
}
