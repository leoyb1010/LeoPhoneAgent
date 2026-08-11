import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

import { mutationsAllowed, requireLocalOnly } from '../../shared/local-only.js';

import { compareSemver, fetchJson } from './version-network.utils.js';

const router = express.Router();

type CliInstallSource = 'unknown' | 'homebrew' | 'pnpm' | 'volta' | 'bun' | 'npm-global' | 'app-bundled' | 'standalone' | 'shim' | 'not-installed';
type CliTool = {
  id: string;
  label?: string;
  cmd: string;
  updateArgs: string[] | null;
  install?: { command: string; args: string[] };
  npmPackage: string | null;
  docsUrl?: string;
};
type CliCommandResult = { ok: boolean; code: string | number; stdout: string; stderr: string; error: string | null };
type CliCopy = {
  /** Path as resolved from PATH order — the first entry is what commands actually run. */
  path: string;
  realPath: string;
  version: string | null;
  source: CliInstallSource;
  active: boolean;
};
type CliLatestCacheEntry = { version: string | null; updatedAt: number };
type CliLatestResult = { version: string | null; checkedAt: string | null; source: string };
type CliLatestOptions = { force?: boolean; now?: number; loadLatest?: (packageName: string) => Promise<string | null> };
type StatusError = Error & { statusCode?: number };

function nowIso(): string {
  return new Date().toISOString();
}

const pendingCliMutations = new Map<string, Promise<unknown>>();
const cliLatestVersionCache = new Map<string, CliLatestCacheEntry>();
const CLI_LATEST_VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Agent CLI tooling: live version + one-click self-update
// ---------------------------------------------------------------------------

const CLI_VERSION_TOKEN = /(?:^|\s|v)(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)(?=\s|$|\))/m;

export const CLI_TOOLS: Record<string, CliTool> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    cmd: 'claude',
    updateArgs: ['update'],
    install: { command: 'npm', args: ['install', '--global', '@anthropic-ai/claude-code'] },
    npmPackage: '@anthropic-ai/claude-code',
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    cmd: 'codex',
    updateArgs: ['update'],
    install: { command: 'npm', args: ['install', '--global', '@openai/codex'] },
    npmPackage: '@openai/codex',
    docsUrl: 'https://github.com/openai/codex',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    cmd: 'opencode',
    // Update selection is resolved from the executable's verified install source.
    updateArgs: ['upgrade'],
    install: { command: 'npm', args: ['install', '--global', 'opencode-ai'] },
    npmPackage: 'opencode-ai',
    docsUrl: 'https://opencode.ai',
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    cmd: 'cursor-agent',
    updateArgs: ['update'],
    npmPackage: null,
    docsUrl: 'https://cursor.com',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    cmd: 'gemini',
    updateArgs: ['update'],
    install: { command: 'npm', args: ['install', '--global', '@google/gemini-cli'] },
    npmPackage: '@google/gemini-cli',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes Agent',
    cmd: 'hermes',
    updateArgs: ['update'],
    npmPackage: null,
    docsUrl: 'https://hermes-agent.nousresearch.com',
  },
  grok: {
    id: 'grok',
    label: 'Grok Build',
    cmd: 'grok',
    updateArgs: ['update'],
    npmPackage: null,
    docsUrl: 'https://grok.com/build',
  },
};

function parseCliVersionText(output: unknown): string | null {
  if (!output) return null;
  const match = String(output).match(CLI_VERSION_TOKEN);
  return match ? match[1] : null;
}

/**
 * Thrown when a probe could not even LOOK for a CLI because spawn itself
 * failed transiently (EBADF fd race in the packaged app). This must never be
 * interpreted as "not installed" — during an npm install/update window the
 * race can persist longer than the per-probe retries, and 1.49.6 briefly
 * poisoned the status snapshot with "全部未安装" exactly this way.
 */
export class TransientProbeError extends Error {
  constructor(message = 'CLI probe failed transiently (spawn EBADF)') {
    super(message);
    this.name = 'TransientProbeError';
  }
}

/** True when a built tool entry was degraded by a transient spawn failure. */
export function toolLooksTransient(tool: { error?: string | null }): boolean {
  return /EBADF/i.test(String(tool.error || ''));
}

/** Last-good merge: a transiently-degraded fresh entry never replaces a good one. */
export function mergeToolWithLastGood<T extends { error?: string | null }>(fresh: T, prev: T | null | undefined): T {
  return prev && toolLooksTransient(fresh) ? prev : fresh;
}

export async function resolveExecutablePath(command: string, platform = process.platform): Promise<string | null> {
  const result = await runCliCommand(platform === 'win32' ? 'where' : 'which', [command], 5000);
  if (!result.ok) return null;
  const executablePath = result.stdout.trim().split(/\r?\n/)[0];
  if (!executablePath) return null;
  try {
    return await fs.realpath(executablePath);
  } catch {
    return executablePath;
  }
}

export function classifyInstallSource(executablePath: string): CliInstallSource {
  const normalized = executablePath.replaceAll('\\', '/');
  // npm installed by Homebrew's Node still lives under lib/node_modules.
  if (/(^|\/)(lib\/node_modules|\.npm-global|npm\/bin)(\/|$)/i.test(normalized)) {
    return 'npm-global';
  }
  if (/(^|\/)(pnpm|pnpm-global)(\/|$)/i.test(normalized)) {
    return 'pnpm';
  }
  if (/(^|\/)\.volta(\/|$)/i.test(normalized)) {
    return 'volta';
  }
  if (/(^|\/)\.bun(\/|$)/i.test(normalized)) {
    return 'bun';
  }
  if (/(^|\/)(Cellar|Caskroom)(\/|$)/i.test(normalized)) {
    return 'homebrew';
  }
  if (normalized.includes('.app/Contents/')) {
    return 'app-bundled';
  }
  if (/(^|\/)(\.asdf|\.local\/share\/mise|mise)\/shims(\/|$)/i.test(normalized)) {
    return 'shim';
  }
  if (/(^|\/)(\.local\/(bin|share\/[^/]+)|\.opencode\/bin|\.grok\/(bin|downloads))(\/|$)/i.test(normalized)) {
    return 'standalone';
  }
  // Native installers (e.g. Claude's) drop a self-updating binary straight
  // into a writable bin directory. Classification runs on the realpath, so
  // package-manager symlinks resolve into their real buckets above and never
  // reach this rule.
  if (/^(\/opt\/homebrew\/bin|\/usr\/local\/bin)\/[^/]+$/.test(normalized)
    || /^\/Users\/[^/]+\/bin\/[^/]+$/.test(normalized)
    || /^\/home\/[^/]+\/bin\/[^/]+$/.test(normalized)) {
    return 'standalone';
  }
  return 'unknown';
}

export async function detectCliInstallSource(tool: CliTool, resolvePath: (command: string) => Promise<string | null> = resolveExecutablePath): Promise<{ source: CliInstallSource; executablePath: string | null }> {
  const executablePath = await resolvePath(tool.cmd);
  if (!executablePath) return { source: 'unknown', executablePath: null };
  return { source: classifyInstallSource(executablePath), executablePath };
}

/**
 * Every copy of the CLI reachable through the USER'S terminal PATH, in
 * resolution order. The first entry is the copy that actually runs when the
 * user types the bare command — status and updates must anchor on it,
 * otherwise the app "updates" a copy the user never executes and the whole
 * feature reads as fake.
 *
 * The lookup deliberately uses the login-shell PATH captured by the desktop
 * shell (LEOCODEBOX_LOGIN_SHELL_PATH), NOT this server's own augmented PATH:
 * the augmented PATH drags in copies from every nvm/fnm node version, which
 * the user's terminal never resolves and which must not count as references.
 */
export async function discoverCliCopies(tool: CliTool): Promise<CliCopy[]> {
  const explicitAgentPath = (process.env.LEOCODEBOX_AGENT_PATH || '').trim();
  const userShellPath = (process.env.LEOCODEBOX_LOGIN_SHELL_PATH || '').trim();
  const discoveryPath = [explicitAgentPath, userShellPath].filter(Boolean).join(process.platform === 'win32' ? ';' : ':');
  const lookupEnv = discoveryPath ? { ...process.env, PATH: discoveryPath } : undefined;
  const runLookup = (env?: NodeJS.ProcessEnv) => (process.platform === 'win32'
    ? runCliCommand('where', [tool.cmd], 5000, { env })
    : runCliCommand('which', ['-a', tool.cmd], 5000, { env }));

  let lookup = await runLookup(lookupEnv);
  if (lookupEnv && (!lookup.ok || !lookup.stdout.trim())) {
    // The explicit/search PATH may genuinely miss the CLI (e.g. installed via
    // a manager the shell config no longer sources). Fall back to the server's
    // broader PATH so detection never regresses below the old behavior.
    lookup = await runLookup(undefined);
  }
  // "which couldn't run" is NOT "CLI not found": a genuinely-missing CLI exits
  // with code 1; a spawn-level EBADF means the probe itself broke — surface it
  // as transient so callers keep the last verified state instead of reporting
  // every tool as 未安装.
  if (!lookup.ok && /EBADF/i.test(lookup.error || '')) {
    throw new TransientProbeError(`which ${tool.cmd}: ${lookup.error}`);
  }
  const rawPaths = lookup.ok ? lookup.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];

  const copies: CliCopy[] = [];
  const seenRealPaths = new Set<string>();
  for (const rawPath of rawPaths.slice(0, 8)) {
    let realPath = rawPath;
    try {
      realPath = await fs.realpath(rawPath);
    } catch {
      // Broken symlink or vanished file: keep the raw path for display.
    }
    if (seenRealPaths.has(realPath)) continue;
    seenRealPaths.add(realPath);
    copies.push({
      path: rawPath,
      realPath,
      version: null,
      source: classifyInstallSource(realPath),
      active: copies.length === 0,
    });
  }

  await Promise.all(copies.map(async (copy) => {
    const probe = await runCliCommand(copy.path, ['--version'], 5000);
    copy.version = probe.ok ? parseCliVersionText(`${probe.stdout}\n${probe.stderr}`) : null;
  }));

  return copies;
}

/**
 * Extracts the npm prefix that owns an installed copy, e.g.
 * `~/.nvm/versions/node/v22.22.3/lib/node_modules/pkg/bin/x` → the v22 root.
 * Updating with an explicit --prefix guarantees npm writes to the SAME
 * install the user runs, instead of whichever npm happens to be on PATH.
 */
export function deriveNpmPrefixFromCopyPath(realPath: string): string | null {
  const normalized = realPath.replaceAll('\\', '/');
  const marker = normalized.indexOf('/lib/node_modules/');
  if (marker > 0) return normalized.slice(0, marker);
  return null;
}

export async function resolveCliUpdateCommand(tool: CliTool, source: CliInstallSource, activeCopy?: CliCopy | null): Promise<{ command: string; args: string[] } | null> {
  if (source === 'npm-global' && tool.npmPackage) {
    const prefix = activeCopy ? deriveNpmPrefixFromCopyPath(activeCopy.realPath) : null;
    return {
      command: 'npm',
      args: [
        'install',
        '--global',
        ...(prefix ? [`--prefix=${prefix}`] : []),
        `${tool.npmPackage}@latest`,
      ],
    };
  }
  if (source === 'homebrew') {
    const formulaById: Record<string, { name: string; cask?: boolean }> = {
      opencode: { name: 'opencode' }, gemini: { name: 'gemini-cli' }, codex: { name: 'codex' }, claude: { name: 'claude-code', cask: true },
    };
    const formula = formulaById[tool.id];
    if (formula) return { command: 'brew', args: ['upgrade', ...(formula.cask ? ['--cask'] : []), formula.name] };
  }
  if (source === 'pnpm' && tool.npmPackage) {
    return { command: 'pnpm', args: ['add', '--global', `${tool.npmPackage}@latest`] };
  }
  if (source === 'volta' && tool.npmPackage) {
    return { command: 'volta', args: ['install', `${tool.npmPackage}@latest`] };
  }
  if (source === 'bun' && tool.npmPackage) {
    return { command: 'bun', args: ['add', '--global', `${tool.npmPackage}@latest`] };
  }
  if (source === 'standalone' && Array.isArray(tool.updateArgs)) {
    // Run the exact copy that PATH resolves to, so a native install at e.g.
    // /opt/homebrew/bin self-updates in place rather than resolving to some
    // other copy in the server's environment.
    return { command: activeCopy?.path || tool.cmd, args: tool.updateArgs };
  }
  return null;
}

export async function withCliMutation<T>(toolId: string, operation: () => Promise<T> | T): Promise<T> {
  if (pendingCliMutations.has(toolId)) {
    const error: StatusError = new Error(`CLI operation already in progress for ${toolId}.`);
    error.statusCode = 409;
    throw error;
  }
  const request = Promise.resolve().then(operation);
  pendingCliMutations.set(toolId, request);
  try {
    return await request;
  } finally {
    if (pendingCliMutations.get(toolId) === request) pendingCliMutations.delete(toolId);
  }
}

// The CLI status panel fans out ~28 probes at once (7 tools × which/which-a/
// --version). In a packaged GUI app (launched from Finder, no real stdin),
// spawning many child processes concurrently can race libuv's fd setup and
// throw transient `spawn EBADF` on some of them. Two measures keep this both
// CORRECT and FAST:
//  - a small concurrency cap (4) keeps the spawn burst tame while a full
//    refresh still finishes in a few seconds (a single-slot serial gate was
//    tried in 1.49.6 and made the panel take 60s+ — unacceptable);
//  - an EBADF retry below converts any残留 transient failure into a short
//    delay instead of a false "not installed".
// Long-running install/update mutations bypass the gate entirely (they are
// already serialised per-tool and would otherwise hog slots for minutes).
const PROBE_TIMEOUT_CEILING_MS = 30_000;
const MAX_CONCURRENT_PROBES = 4;
let activeProbeCount = 0;
const probeSpawnWaiters: Array<() => void> = [];
function acquireProbeSlot(): Promise<void> {
  if (activeProbeCount < MAX_CONCURRENT_PROBES) {
    activeProbeCount += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => { probeSpawnWaiters.push(resolve); });
}
function releaseProbeSlot(): void {
  const next = probeSpawnWaiters.shift();
  if (next) next(); // hand the slot straight to the next waiter
  else activeProbeCount -= 1;
}

// `spawn EBADF` is a TRANSIENT libuv fd race in the packaged GUI app — worst
// during the first seconds after launch (Electron is still wiring the process
// up), where even fully-serialised spawns fail. Reproduced: cold boot → several
// probes EBADF; 10s later the same probes all pass. So an EBADF result is never
// "not installed" — it's "try again in a moment". Without the retry, a launch-
// time status fetch showed every CLI as 未安装 even though all were installed.
// An npm install/update spawns many short-lived processes of its own, so the
// EBADF window around a mutation can outlast a couple of quick retries. Linear
// backoff over 8 attempts spans ~10.8s, which covered every window observed
// while an update was running. Only EBADF results retry, so a genuinely broken
// CLI still fails immediately.
const EBADF_RETRY_LIMIT = 8;
const EBADF_RETRY_DELAY_MS = 300;
function isTransientSpawnFailure(result: CliCommandResult): boolean {
  return !result.ok && /EBADF/i.test(result.error || '');
}

/**
 * Re-run a spawn until it stops failing with a transient EBADF.
 *
 * Extracted so BOTH the throttled probe path and the un-throttled mutation path
 * provably share it — they used to diverge, and that divergence is what made
 * updates fail outright (see runCliCommand).
 */
export async function retryOnTransientSpawn(
  run: () => Promise<CliCommandResult>,
  {
    limit = EBADF_RETRY_LIMIT,
    delayMs = EBADF_RETRY_DELAY_MS,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  }: { limit?: number; delayMs?: number; sleep?: (ms: number) => Promise<unknown> } = {},
): Promise<CliCommandResult> {
  let result = await run();
  for (let attempt = 0; attempt < limit && isTransientSpawnFailure(result); attempt += 1) {
    await sleep(delayMs * (attempt + 1));
    result = await run();
  }
  return result;
}

export async function runCliCommand(cmd: string, args: string[], timeoutMs = 10_000, options: { env?: NodeJS.ProcessEnv } = {}): Promise<CliCommandResult> {
  // Long mutations (install/update) run OUTSIDE the probe gate so they never
  // hold a slot for minutes — but they still need the EBADF retry.
  //
  // These were previously conflated: the early return that skipped the gate
  // also skipped the retry, so every install/update ran with ZERO EBADF
  // protection while ordinary probes retried happily. That is precisely how an
  // update died outright with `which claude: spawn EBADF` — during the very
  // window (npm spawning) when the race is most likely. Only the GATE is
  // conditional now; the retry always applies.
  const throttled = timeoutMs <= PROBE_TIMEOUT_CEILING_MS;
  if (throttled) await acquireProbeSlot();
  try {
    return await retryOnTransientSpawn(() => runCliCommandUnthrottled(cmd, args, timeoutMs, options));
  } finally {
    if (throttled) releaseProbeSlot();
  }
}

function runCliCommandUnthrottled(cmd: string, args: string[], timeoutMs: number, options: { env?: NodeJS.ProcessEnv }): Promise<CliCommandResult> {
  return new Promise<CliCommandResult>((resolve) => {
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
    const MAX_OUTPUT = 4 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: CliCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      // stdin MUST be 'ignore' (/dev/null): a packaged GUI app (launched from
      // Finder) has no real stdin, so creating the child's stdin pipe fails with
      // `spawn EBADF` and every CLI probe dies ("无法读取本机智能体状态: spawn
      // EBADF"). All the sibling probes already ignore stdin — this brings the
      // shared CLI-command helper in line.
      child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: useShell,
        ...(options.env ? { env: options.env } : {}),
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      resolve({ ok: false, code: err?.code ?? 1, stdout: '', stderr: '', error: err?.message ?? String(error) });
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      finish({ ok: false, code: 124, stdout, stderr, error: `Timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on('data', (data: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += data.toString('utf8'); });
    child.stderr?.on('data', (data: Buffer) => { if (stderr.length < MAX_OUTPUT) stderr += data.toString('utf8'); });
    child.on('error', (error: NodeJS.ErrnoException) => finish({ ok: false, code: error.code ?? 1, stdout, stderr, error: error.message }));
    child.on('close', (code) => finish({ ok: code === 0, code: code ?? 0, stdout, stderr, error: code === 0 ? null : `Exited with code ${code}` }));
  });
}

export async function readCliLatestVersion(tool: CliTool, {
  force = false,
  now = Date.now(),
  loadLatest = async (packageName: string) => {
    const encoded = packageName.replace('@', '%40').replace('/', '%2F');
    const registry = String(process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');
    const info = await fetchJson(`${registry}/${encoded}/latest`) as { version?: string };
    return info.version || null;
  },
} = {}) {
  if (!tool.npmPackage) return { version: null, checkedAt: null, source: 'unsupported' };
  const cached = cliLatestVersionCache.get(tool.id);
  if (!force && cached && now - cached.updatedAt < CLI_LATEST_VERSION_CACHE_TTL_MS) {
    return { version: cached.version, checkedAt: new Date(cached.updatedAt).toISOString(), source: 'cache' };
  }
  try {
    const version = await loadLatest(tool.npmPackage);
    cliLatestVersionCache.set(tool.id, { version, updatedAt: now });
    return { version, checkedAt: new Date(now).toISOString(), source: 'registry' };
  } catch {
    return cached
      ? { version: cached.version, checkedAt: new Date(cached.updatedAt).toISOString(), source: 'stale-cache' }
      : { version: null, checkedAt: new Date(now).toISOString(), source: 'unavailable' };
  }
}

export function clearCliLatestVersionCache(): void {
  cliLatestVersionCache.clear();
}

export async function getCliToolStatus(tool: CliTool, { checkLatest = true, forceLatest = false }: { checkLatest?: boolean; forceLatest?: boolean } = {}) {
  // Anchor everything on the PATH-active copy: that is the binary the bare
  // command actually runs. Additional copies are reported so version drift
  // between package managers is visible instead of silently confusing.
  const copies = await discoverCliCopies(tool);
  const active = copies[0] ?? null;
  const installed = Boolean(active);
  let runnable = Boolean(active?.version);
  let probeError: string | null = null;
  if (active && !active.version) {
    const probe = await runCliCommand(active.path, ['--version'], 5000);
    runnable = probe.ok;
    probeError = (probe.stderr || probe.error || `${tool.cmd} could not run`).trim();
    if (probe.ok) active.version = parseCliVersionText(probe.stdout || probe.stderr);
  }
  const currentVersion = active?.version ?? null;
  // Only a DRIFT THAT AFFECTS YOU is worth surfacing: the copy the bare command
  // actually runs (copies[0]) being behind a newer shadowed copy. Older copies
  // sitting in other node roots while you already run the newest are pure noise
  // — the single most common case on multi-manager (nvm + brew + npm) machines.
  const hasNewerShadowCopy = Boolean(currentVersion)
    && copies.some((copy) => copy.version && compareSemver(copy.version, currentVersion) > 0);
  const newestCopyVersion = copies.reduce<string | null>((newest, copy) => (
    copy.version && (!newest || compareSemver(copy.version, newest) > 0) ? copy.version : newest
  ), null);
  const latest = checkLatest && runnable
    ? await readCliLatestVersion(tool, { force: forceLatest })
    : { version: null, checkedAt: null, source: 'skipped' };
  const latestVersion = latest.version;
  const updateAvailable = Boolean(
    currentVersion && latestVersion && compareSemver(latestVersion, currentVersion) > 0,
  );
  const installSource: CliInstallSource = active ? active.source : 'not-installed';
  const updateCommand = runnable ? await resolveCliUpdateCommand(tool, installSource, active) : null;
  const allowMutations = mutationsAllowed();
  const manualHint = updateCommand
    ? [updateCommand.command, ...updateCommand.args].join(' ')
    : tool.npmPackage ? `npm install --global ${tool.npmPackage}@latest` : null;
  return {
    id: tool.id,
    label: tool.label,
    command: tool.cmd,
    installed,
    runnable,
    error: runnable ? null : (probeError || `${tool.cmd} could not run`),
    currentVersion,
    latestVersion,
    latestCheckedAt: latest.checkedAt,
    latestVersionSource: latest.source,
    updateAvailable,
    installSource,
    executablePath: active?.path ?? null,
    copies,
    hasNewerShadowCopy,
    newestCopyVersion,
    canInstall: !installed && Boolean(tool.install),
    canSelfUpdate: runnable && Boolean(updateCommand),
    mutationsAllowed: allowMutations,
    manualHint,
    docsUrl: tool.docsUrl,
  };
}

// ---------------------------------------------------------------------------
// Status snapshot: serve instantly, refresh in the background.
//
// A full live probe spawns ~28 child processes and hits the npm registry — at
// app launch (cold caches + the packaged app's EBADF-prone boot window) that
// took 20-60s, so the 本机智能体 panel sat on skeletons. CLIs don't change
// under the app's feet between launches, so the last verified result is the
// right thing to show immediately; a background single-flight probe refreshes
// the snapshot and the panel silently re-fetches the fresh data.
// ---------------------------------------------------------------------------
const CLI_STATUS_SNAPSHOT_PATH = path.join(os.homedir(), '.leocodebox', 'cache', 'cli-status.json');
type CliStatusPayload = {
  success: true;
  checkedAt: string;
  mutationsAllowed: boolean;
  tools: Awaited<ReturnType<typeof getCliToolStatus>>[];
  /** true when this response came from the on-disk snapshot; a live refresh is running. */
  stale?: boolean;
};

let cliStatusInFlight: { promise: Promise<CliStatusPayload>; force: boolean } | null = null;

type CliToolStatusEntry = Awaited<ReturnType<typeof getCliToolStatus>>;

/** Entry used when a probe broke transiently and there is no last-good state yet. */
function transientPlaceholderTool(tool: CliTool): CliToolStatusEntry {
  return {
    id: tool.id,
    label: tool.label,
    command: tool.cmd,
    installed: false,
    runnable: false,
    error: '探测暂时失败(spawn EBADF),稍后会自动重试。',
    currentVersion: null,
    latestVersion: null,
    latestCheckedAt: null,
    latestVersionSource: 'skipped',
    updateAvailable: false,
    installSource: 'unknown',
    executablePath: null,
    copies: [],
    hasNewerShadowCopy: false,
    newestCopyVersion: null,
    canInstall: false,
    canSelfUpdate: false,
    mutationsAllowed: mutationsAllowed(),
    manualHint: tool.npmPackage ? `npm install --global ${tool.npmPackage}@latest` : null,
    docsUrl: tool.docsUrl,
    // getCliToolStatus's inferred type narrows executablePath to `string`
    // (copies[0].path is always string there); the wire type is string|null.
  } as unknown as CliToolStatusEntry;
}

async function buildCliStatusPayload(forceLatest: boolean): Promise<CliStatusPayload> {
  const previous = await readCliStatusSnapshot();
  const tools = await Promise.all(
    Object.values(CLI_TOOLS).map(async (tool) => {
      const prev = previous?.tools.find((entry) => entry.id === tool.id) ?? null;
      try {
        // EBADF anywhere in the probe chain means "unknown", never "broken" —
        // keep the last verified entry instead of degrading it (a poisoned
        // snapshot once showed every installed CLI as 未安装).
        return mergeToolWithLastGood(await getCliToolStatus(tool, { forceLatest }), prev);
      } catch (error) {
        if (error instanceof TransientProbeError) return prev ?? transientPlaceholderTool(tool);
        throw error;
      }
    }),
  );
  const payload: CliStatusPayload = { success: true, checkedAt: nowIso(), mutationsAllowed: mutationsAllowed(), tools };
  try {
    await fs.mkdir(path.dirname(CLI_STATUS_SNAPSHOT_PATH), { recursive: true });
    await fs.writeFile(CLI_STATUS_SNAPSHOT_PATH, JSON.stringify(payload));
  } catch { /* snapshot is best-effort; the live payload is still returned */ }
  return payload;
}

/**
 * getCliToolStatus for mutation handlers: a transient probe failure falls back
 * to the snapshot instead of failing the mutation with a bogus "not installed"
 * (that's exactly how clicking 更新 during an EBADF window bricked the panel).
 */
async function getCliToolStatusResilient(tool: CliTool): Promise<CliToolStatusEntry> {
  try {
    const fresh = await getCliToolStatus(tool, { checkLatest: false });
    if (!toolLooksTransient(fresh)) return fresh;
    const prev = (await readCliStatusSnapshot())?.tools.find((entry) => entry.id === tool.id);
    return prev ?? fresh;
  } catch (error) {
    if (!(error instanceof TransientProbeError)) throw error;
    const prev = (await readCliStatusSnapshot())?.tools.find((entry) => entry.id === tool.id);
    if (prev) return prev;
    throw error;
  }
}

export function refreshCliStatusSnapshot(forceLatest = false): Promise<CliStatusPayload> {
  // Single-flight: reuse an in-flight probe unless the caller needs a forced
  // registry check and the running one is not forced.
  if (cliStatusInFlight && (cliStatusInFlight.force || !forceLatest)) return cliStatusInFlight.promise;
  const promise = buildCliStatusPayload(forceLatest).finally(() => {
    if (cliStatusInFlight?.promise === promise) cliStatusInFlight = null;
  });
  cliStatusInFlight = { promise, force: forceLatest };
  return promise;
}

async function readCliStatusSnapshot(): Promise<CliStatusPayload | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(CLI_STATUS_SNAPSHOT_PATH, 'utf8')) as CliStatusPayload;
    if (!parsed || parsed.success !== true || !Array.isArray(parsed.tools) || parsed.tools.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

router.get('/status', async (req, res, next) => {
  try {
    const forceLatest = req.query?.refresh === '1';
    if (!forceLatest) {
      const snapshot = await readCliStatusSnapshot();
      if (snapshot) {
        void refreshCliStatusSnapshot(false).catch(() => { /* next fetch retries */ });
        // mutationsAllowed reflects THIS runtime, not the snapshotting one.
        res.json({ ...snapshot, mutationsAllowed: mutationsAllowed(), stale: true });
        return;
      }
    }
    res.json(await refreshCliStatusSnapshot(forceLatest));
  } catch (error) {
    next(error);
  }
});

router.post('/:id/install', requireLocalOnly, async (req, res, next) => {
  try {
    const id = String(req.params.id || '').toLowerCase();
    const tool = Object.hasOwn(CLI_TOOLS, id) ? CLI_TOOLS[id] : null;
    if (!tool) {
      res.status(404).json({ success: false, error: 'Unknown CLI tool.' });
      return;
    }
    if (!tool.install) {
      res.status(409).json({ success: false, error: `${tool.label} 没有经过验证的一键安装方式。` });
      return;
    }
    const install = tool.install;
    const payload = await withCliMutation(tool.id, async () => {
      const before = await getCliToolStatusResilient(tool);
      if (before.installed) {
        const error: StatusError = new Error(`${tool.label} 已安装。`);
        error.statusCode = 409;
        throw error;
      }
      const result = await runCliCommand(install.command, install.args, 300_000);
      // Same rule as update: the install command owns the verdict. A post-check
      // that cannot spawn must not report a successful install as failed.
      const after = await getCliToolStatusResilient(tool).catch((error) => {
        if (result.ok && error instanceof TransientProbeError) return before;
        throw error;
      });
      return {
        success: result.ok && (after.installed || after === before),
        tool: tool.id,
        currentVersion: after.currentVersion,
        installSource: after.installSource,
        output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 8000),
        error: result.ok && after.installed ? null : (result.error || 'Install command failed.'),
      };
    });
    // The mutation changed on-disk CLI state — refresh the snapshot so the
    // next panel load shows the new version immediately.
    void refreshCliStatusSnapshot(false).catch(() => {});
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/update', requireLocalOnly, async (req, res, next) => {
  try {
    const id = String(req.params.id || '').toLowerCase();
    const tool = Object.hasOwn(CLI_TOOLS, id) ? CLI_TOOLS[id] : null;
    if (!tool) {
      res.status(404).json({ success: false, error: 'Unknown CLI tool.' });
      return;
    }
    const payload = await withCliMutation(tool.id, async () => {
      const before = await getCliToolStatusResilient(tool);
      if (!before.installed) {
        const error: StatusError = new Error(`${tool.label} CLI is not installed.`);
        error.statusCode = 409;
        throw error;
      }
      const activeBefore = before.copies.find((copy) => copy.active) ?? null;
      const updateCommand = await resolveCliUpdateCommand(tool, before.installSource as CliInstallSource, activeBefore);
      if (!updateCommand) {
        const error: StatusError = new Error(`${tool.label} 的安装来源为 ${before.installSource}，无法安全自动更新。`);
        error.statusCode = 409;
        throw error;
      }
      const result = await runCliCommand(updateCommand.command, updateCommand.args, 300_000);
      // The verdict belongs to the update command itself. The post-check is
      // only there to report the resulting version, and it runs in the exact
      // window where spawn is flakiest — so a probe that cannot run must never
      // turn a SUCCESSFUL update into "更新失败: which claude: spawn EBADF".
      const after = await getCliToolStatusResilient(tool).catch((error) => {
        if (result.ok && error instanceof TransientProbeError) return before;
        throw error;
      });
      // Compare the SAME copy before and after; a bare currentVersion diff
      // could be another copy shadowing the one we just updated.
      const afterAtSamePath = activeBefore
        ? after.copies.find((copy) => copy.path === activeBefore.path) ?? null
        : null;
      const versionAtPathAfter = afterAtSamePath?.version ?? after.currentVersion;
      const combinedOutput = `${result.stdout}\n${result.stderr}`;

      let friendlyError = result.ok ? null : (result.error || 'Update command failed.');
      if (!result.ok && /unauthenticated/i.test(combinedOutput)) {
        friendlyError = `${tool.label} 的自更新需要该 CLI 自己的登录态，请在你的终端运行 ${updateCommand.command} ${updateCommand.args.join(' ')}（必要时先登录）。`;
      }

      let notice: string | null = null;
      if (tool.npmPackage && /allow-scripts/i.test(combinedOutput) && combinedOutput.includes(tool.npmPackage)) {
        notice = `npm 的 allow-scripts 拦截了 ${tool.npmPackage} 的安装脚本，更新可能不完整。终端执行一次：npm install -g --allow-scripts=${tool.npmPackage} ${tool.npmPackage}@latest`;
      }
      // Only nag about shadow copies when the active one is STILL behind a
      // newer copy after updating — i.e. the update landed somewhere the bare
      // command doesn't run. If the copy you run is now the newest, older
      // copies elsewhere are harmless and not worth a warning.
      const activeAfterVersion = after.copies[0]?.version ?? null;
      const activeStillStale = Boolean(activeAfterVersion)
        && after.copies.some((copy) => copy.version && compareSemver(copy.version, activeAfterVersion) > 0);
      if (result.ok && activeStillStale) {
        const shadowNote = `更新装到了另一处,你终端里实际会跑的仍是旧版 ${tool.label}(${activeBefore?.path ?? after.executablePath})。请对这份路径单独更新或清理旧副本。`;
        notice = notice ? `${notice}\n${shadowNote}` : shadowNote;
      }

      return {
        success: result.ok,
        tool: tool.id,
        previousVersion: activeBefore?.version ?? before.currentVersion,
        currentVersion: versionAtPathAfter,
        changed: (activeBefore?.version ?? before.currentVersion) !== versionAtPathAfter,
        activePath: activeBefore?.path ?? before.executablePath,
        copies: after.copies,
        notice,
        output: combinedOutput.trim().slice(0, 8000),
        error: friendlyError,
      };
    });
    // The mutation changed on-disk CLI state — refresh the snapshot so the
    // next panel load shows the new version immediately.
    void refreshCliStatusSnapshot(false).catch(() => {});
    res.json(payload);
  } catch (error) {
    next(error);
  }
});


export default router;
