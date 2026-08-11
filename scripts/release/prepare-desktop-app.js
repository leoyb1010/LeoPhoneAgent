#!/usr/bin/env node
import { constants, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const stageDir = process.env.LEOCODEBOX_DESKTOP_STAGE_DIR
  ? path.resolve(process.env.LEOCODEBOX_DESKTOP_STAGE_DIR)
  : path.join(rootDir, '.desktop-build', 'desktop-app');
const macOutputDir = path.join(rootDir, 'release', 'desktop', 'mac-arm64');
let removedDependencyConflictCopies = 0;

const packageJson = JSON.parse(
  await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'),
);
const packageLock = JSON.parse(
  await fs.readFile(path.join(rootDir, 'package-lock.json'), 'utf8'),
);

function getElectronVersion() {
  try {
    return JSON.parse(
      readFileSync(path.join(rootDir, 'node_modules', 'electron', 'package.json'), 'utf8'),
    ).version;
  } catch {
    try {
      return JSON.parse(
        readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'),
      ).packages['node_modules/electron'].version;
    } catch {
      throw new Error('Could not resolve an exact Electron version for desktop packaging.');
    }
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyRequired(relativePath) {
  const from = path.join(rootDir, relativePath);
  const to = path.join(stageDir, relativePath);
  if (!(await pathExists(from))) {
    throw new Error(`Required desktop build input is missing: ${relativePath}`);
  }
  await fs.cp(from, to, { recursive: true });
}

async function copyIfExists(relativePath) {
  const from = path.join(rootDir, relativePath);
  if (!(await pathExists(from))) return false;
  await fs.cp(from, path.join(stageDir, relativePath), { recursive: true });
  return true;
}

async function copyNodeModule(packageName) {
  const parts = packageName.split('/');
  const source = path.join(rootDir, 'node_modules', ...parts);
  if (!(await pathExists(source))) return false;

  const target = path.join(stageDir, 'node_modules', ...parts);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true });
  return true;
}

function createConcurrencyGate(limit) {
  let active = 0;
  const waiters = [];

  return async (task) => {
    if (active >= limit) {
      await new Promise((resolve) => waiters.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiters.shift()?.();
    }
  };
}

const withCopySlot = createConcurrencyGate(24);

async function copyTree(source, target, filter) {
  if (!filter(source)) return;

  const sourceStat = await withCopySlot(() => fs.lstat(source));
  if (sourceStat.isDirectory()) {
    await withCopySlot(() => fs.mkdir(target, { recursive: true }));
    const entries = await withCopySlot(() => fs.readdir(source));
    await Promise.all(entries.map((entry) => copyTree(
      path.join(source, entry),
      path.join(target, entry),
      filter,
    )));
    return;
  }

  if (sourceStat.isSymbolicLink()) {
    const linkTarget = await withCopySlot(() => fs.readlink(source));
    await withCopySlot(() => fs.symlink(linkTarget, target));
    return;
  }

  if (sourceStat.isFile()) {
    await withCopySlot(async () => {
      await fs.copyFile(source, target, constants.COPYFILE_FICLONE);
      await fs.chmod(target, sourceStat.mode);
    });
  }
}

async function copyRuntimeNodeModules() {
  const sourceRoot = path.join(rootDir, 'node_modules');
  const targetRoot = path.join(stageDir, 'node_modules');
  if (!(await pathExists(sourceRoot))) {
    throw new Error('Required desktop build input is missing: node_modules');
  }

  await copyTree(sourceRoot, targetRoot, (source) => {
      const relative = path.relative(sourceRoot, source);
      if (!relative) return true;
      const parts = relative.split(path.sep);
      const leafName = parts.at(-1) || '';

      // Type declarations and source maps are development/debug artifacts.
      // Electron executes the emitted JavaScript, so staging these files only
      // inflates ASAR size and multiplies small-file I/O on cloud-backed disks.
      if (/\.d\.(?:ts|mts|cts)$/.test(leafName) || leafName.endsWith('.map')) return false;

      // Finder/iCloud conflict copies are never part of the dependency graph.
      // Reject them while copying so release staging does not need a second,
      // very slow recursive walk across node_modules on Documents volumes.
      if (/(?:\s2| copy|conflicted copy)\.[^.]+$/i.test(leafName)) {
        removedDependencyConflictCopies += 1;
        return false;
      }

      // package-lock v3 marks packages that are reachable only from
      // devDependencies. electron-builder would prune these after staging, so
      // copying them first is pure I/O. Check only exact package-root entries;
      // descendants inherit the decision made when fs.cp enters that root.
      const lockKey = `node_modules/${parts.join('/')}`;
      if (packageLock.packages?.[lockKey]?.dev === true) return false;

      // Vite's dependency cache is development-only, can contain thousands of
      // tiny files, and is regenerated from package dependencies. Copying it
      // into the release stage was the slowest part of packaging on iCloud /
      // Documents volumes even though electron-builder never needs it.
      if (parts[0].startsWith('.vite') || parts[0] === '.cache') return false;

      // These platform binaries are deliberately downloaded on demand or
      // replaced by the user's own CLI. Skip them before staging instead of
      // spending minutes copying data that electron-builder removes later.
      if (parts[0] === '@anthropic-ai'
        && /^claude-agent-sdk-(?:darwin|linux|win32)-/.test(parts[1] || '')) return false;
      if (parts[0] === '@openai'
        && /^codex-(?:darwin|linux|win32)-/.test(parts[1] || '')) return false;
      if (parts[0] === 'playwright-core'
        && parts[1] === '.local-browsers'
        && /^chromium-/.test(parts[2] || '')) return false;

      return true;
  });
}

async function findConflictCopies(directory) {
  const matches = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...await findConflictCopies(fullPath));
    } else if (/(?:\s2| copy|conflicted copy)\.[^.]+$/i.test(entry.name)) {
      matches.push(path.relative(rootDir, fullPath));
    }
  }
  return matches;
}

function buildDesktopPackageJson(copiedOptionalDependencies) {
  return {
    name: `${packageJson.name}-desktop`,
    version: packageJson.version,
    productName: packageJson.productName,
    description: `${packageJson.productName} desktop shell`,
    author: packageJson.author,
    license: packageJson.license,
    type: 'module',
    main: 'electron/main.js',
    dependencies: packageJson.dependencies,
    optionalDependencies: copiedOptionalDependencies,
    build: {
      appId: packageJson.build.appId,
      productName: packageJson.build.productName,
      asar: packageJson.build.asar,
      artifactName: packageJson.build.artifactName,
      electronVersion: getElectronVersion(),
      directories: {
        output: path.join(rootDir, 'release', 'desktop'),
      },
      extraMetadata: {
        main: 'electron/main.js',
      },
      files: [
        'electron/**',
        'public/**',
        'dist/**',
        'dist-server/**',
        'node_modules/**',
        // The Claude Agent SDK ships a ~226MB prebuilt CLI binary per platform,
        // but leocodebox always points the SDK at the user's own `claude`
        // executable (see server/modules/providers/list/claude/claude-runtime.js -> pathToClaudeCodeExecutable),
        // so the bundled binary is dead weight. Mirrors the exclusion in the
        // root package.json build.files that the staged config previously lost.
        '!**/node_modules/@anthropic-ai/claude-agent-sdk-{darwin,linux,win32}-*/**',
        // The codex fallback binary (~300MB) is downloaded on first use into
        // ~/.leocodebox/vendor/codex instead of shipping inside the DMG
        // (see server/modules/providers/list/codex/codex-fallback.service.ts).
        '!**/node_modules/@openai/codex-{darwin,linux,win32}-*/**',
        // Browser automation uses the smaller headless shell. Exclude the full
        // Chrome-for-Testing bundle if a developer installed both variants.
        '!**/node_modules/playwright-core/.local-browsers/chromium-*/**',
        'package.json',
        'README.md',
        'README.zh-CN.md',
        'LICENSE',
        'NOTICE',
      ],
      afterPack: packageJson.build.afterPack,
      protocols: packageJson.build.protocols,
      mac: packageJson.build.mac,
      win: packageJson.build.win,
      nsis: packageJson.build.nsis,
      publish: packageJson.build.publish,
    },
  };
}

// electron-builder does not reliably replace an existing .app bundle on APFS;
// it can create conflict copies such as `leocodebox 2.app`, then recurse into
// a malformed directory tree. Every release stage starts from clean outputs.
await Promise.all([
  fs.rm(stageDir, { recursive: true, force: true }),
  fs.rm(macOutputDir, { recursive: true, force: true }),
]);
await fs.mkdir(stageDir, { recursive: true });

const conflictCopies = (await Promise.all(
  ['src', 'server', 'electron', 'scripts'].map((directory) => findConflictCopies(path.join(rootDir, directory))),
)).flat();
if (conflictCopies.length > 0) {
  throw new Error(`Release input contains conflict-copy files:\n${conflictCopies.join('\n')}`);
}

await copyRequired('electron');
await copyRequired('dist');
await copyRequired('dist-server');
await copyRequired('public');

// public/visuals is a byte-for-byte duplicate of dist/visuals (Vite copies
// public/* into dist/ at build, and the server serves both). Only brand/ is
// read from disk by file path (the launch splash in electron/placeholder.html);
// every other subfolder is HTTP-served and resolves from dist/visuals. Drop the
// redundant subfolders from the shipped app — webp is incompressible, so this is
// the single largest DMG saving. Deleting from the stage is deterministic;
// electron-builder `files` negations of an already-included dir are not.
const stagedVisualsRoot = path.join(stageDir, 'public', 'visuals');
if (await pathExists(stagedVisualsRoot)) {
  for (const entry of await fs.readdir(stagedVisualsRoot)) {
    if (entry !== 'brand') {
      await fs.rm(path.join(stagedVisualsRoot, entry), { recursive: true, force: true });
    }
  }
}

await copyRuntimeNodeModules();

const stagedBrowserRoot = path.join(stageDir, 'node_modules', 'playwright-core', '.local-browsers');
if (await pathExists(stagedBrowserRoot)) {
  for (const entry of await fs.readdir(stagedBrowserRoot)) {
    if (entry.startsWith('chromium-')) {
      await fs.rm(path.join(stagedBrowserRoot, entry), { recursive: true, force: true });
    }
  }
}
await copyRequired('README.md');
await copyRequired('README.zh-CN.md');
await copyRequired('LICENSE');
await copyRequired('NOTICE');
// Signing entitlements (only used when LEOCODEBOX_SIGN_IDENTITY is set; harmless otherwise).
await copyIfExists('build');
// afterPack hook must live in the staged project so electron-builder can run it
// (it strips extended attributes so code signing does not fail on "detritus").
await copyIfExists('scripts/release/after-pack.cjs');

const copiedRuntimeDependencies = [];
if (await copyNodeModule('ws')) {
  copiedRuntimeDependencies.push('ws');
} else {
  throw new Error('Required desktop dependency is missing from node_modules: ws');
}

const copiedOptionalDependencies = {};
for (const [name, version] of Object.entries(packageJson.optionalDependencies || {})) {
  if (await copyNodeModule(name)) {
    copiedOptionalDependencies[name] = version;
  }
}

await fs.writeFile(
  path.join(stageDir, 'package.json'),
  `${JSON.stringify(buildDesktopPackageJson(copiedOptionalDependencies), null, 2)}\n`,
  'utf8',
);

console.log(`Prepared thin desktop app at ${stageDir}`);
console.log(`Removed dependency conflict copies: ${removedDependencyConflictCopies}`);
console.log(`Runtime dependencies: ${copiedRuntimeDependencies.join(', ')}`);
if (Object.keys(copiedOptionalDependencies).length) {
  console.log(`Optional dependencies: ${Object.keys(copiedOptionalDependencies).join(', ')}`);
}
