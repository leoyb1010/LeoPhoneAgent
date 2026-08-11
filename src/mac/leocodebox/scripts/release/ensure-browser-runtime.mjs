#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const browserRoot = path.join(rootDir, 'node_modules', 'playwright-core', '.local-browsers');

function hasHeadlessChromium() {
  try {
    return fs.readdirSync(browserRoot).some((entry) => entry.startsWith('chromium_headless_shell-'));
  } catch {
    return false;
  }
}

if (!hasHeadlessChromium()) {
  const playwrightCli = path.join(rootDir, 'node_modules', 'playwright', 'cli.js');
  if (!fs.existsSync(playwrightCli)) {
    throw new Error('Playwright is missing. Run npm install before staging the desktop app.');
  }
  const result = spawnSync(
    process.execPath,
    [playwrightCli, 'install', '--only-shell', 'chromium'],
    {
      cwd: rootDir,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' },
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) {
    throw new Error(`Failed to install the bundled Chromium runtime (exit ${result.status ?? 'unknown'}).`);
  }
}

if (!hasHeadlessChromium()) {
  throw new Error('Bundled Chromium runtime is still missing after installation.');
}

console.log('Bundled Playwright headless Chromium runtime is ready.');
