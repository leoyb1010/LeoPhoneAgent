import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronBinary = process.platform === 'darwin'
  ? path.join(projectRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(projectRoot, 'node_modules/.bin/electron');
const tsxCli = path.join(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const viteCli = path.join(projectRoot, 'node_modules/vite/bin/vite.js');
const developmentToken = randomBytes(32).toString('base64url');

const sharedEnvironment = {
  ...process.env,
  HOST: '127.0.0.1',
  SERVER_PORT: '38473',
  LEOCODEBOX_LOCAL_ONLY: '1',
  LEOCODEBOX_LOCAL_AUTH_TOKEN: developmentToken,
};
const desktopEnvironment = {
  ...sharedEnvironment,
  ELECTRON_DEV_URL: 'http://127.0.0.1:5173',
};
delete desktopEnvironment.ELECTRON_RUN_AS_NODE;

const children = new Set();
let shuttingDown = false;

function start(command, args, environment = sharedEnvironment) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: environment,
    stdio: 'inherit',
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function stopAll(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

function request(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 900 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.once('timeout', () => {
      request.destroy();
      resolve({ status: 0, body: '' });
    });
    request.once('error', () => resolve({ status: 0, body: '' }));
  });
}

async function waitFor(url, label, accepts, child, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label} exited before becoming ready (code ${child.exitCode ?? 'null'}, signal ${child.signalCode ?? 'null'}).`);
    }
    if (accepts(await request(url))) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`Development port ${port} is already in use.`)));
    probe.once('listening', () => probe.close(resolve));
    probe.listen(port, '127.0.0.1');
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopAll(signal);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

try {
  await Promise.all([assertPortAvailable(38473), assertPortAvailable(5173)]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const server = start(
  electronBinary,
  [tsxCli, '--tsconfig', 'server/tsconfig.json', 'server/index.ts'],
  { ...sharedEnvironment, ELECTRON_RUN_AS_NODE: '1' },
);
const client = start(process.execPath, [viteCli, '--host', '127.0.0.1', '--strictPort']);

for (const [child, label] of [[server, 'Development backend'], [client, 'Vite client']]) {
  child.once('exit', (code, signal) => {
    if (shuttingDown) return;
    stopAll();
    console.error(`${label} exited before the desktop shell (code ${code ?? 'null'}, signal ${signal ?? 'null'}).`);
    process.exitCode = code || 1;
  });
}

try {
  await Promise.all([
    waitFor('http://127.0.0.1:38473/health', 'Development backend', ({ status, body }) => {
      if (status !== 200) return false;
      try {
        const payload = JSON.parse(body);
        return payload?.status === 'ok' && typeof payload?.installMode === 'string';
      } catch {
        return false;
      }
    }, server),
    waitFor(
      'http://127.0.0.1:5173/',
      'Vite client',
      ({ status, body }) => status === 200 && body.includes('id="root"'),
      client,
    ),
  ]);

  const desktop = start(
    electronBinary,
    ['electron/main.js'],
    desktopEnvironment,
  );
  desktop.once('exit', (code, signal) => {
    stopAll();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
} catch (error) {
  stopAll();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
