/**
 * Read-only, sandboxed tools for the pi kernel v0.
 *
 * v0 is deliberately read-only: no file writes, no shell. That keeps the very
 * first self-owned agent runtime safe by construction while still being genuinely
 * useful (codebase questions, "find where X is handled"). Every path is confined
 * to a root — resolved, symlink-followed, and re-checked for containment — so a
 * model cannot escape the root via `..` or a symlink.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ToolExecutor, ToolResult, ToolSpec } from './kernel.js';

const MAX_FILE_BYTES = 64 * 1024;
const MAX_DIR_ENTRIES = 500;
const MAX_WRITE_BYTES = 256 * 1024;
const SHELL_TIMEOUT_MS = 30_000;
const SHELL_MAX_OUTPUT = 32 * 1024;

/** Kernel tool capabilities for one run. Both OFF by default — a run only ever
 *  gets write/exec when the caller explicitly opts in (per-run, not global). */
export type KernelCapabilities = { allowWrite?: boolean; allowExec?: boolean };

/**
 * The most catastrophic shell patterns — a thin guard against an obviously
 * destructive command, NOT a security sandbox. run_shell runs with the user's
 * own privileges; it is opt-in per run and defaults off precisely because it is
 * not sandboxed. This list only blocks the few patterns that are almost never
 * intended from an agent.
 */
const SHELL_DENYLIST: RegExp[] = [
  /\brm\s+-[a-z]*[rf]/i, // rm -rf / rm -f
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\b[^|]*\bof=\/dev\//i,
  /:\s*\(\s*\)\s*\{/, // fork bomb :(){
  />\s*\/dev\/(sd|disk|nvme)/i,
  /\bshutdown\b|\breboot\b|\bhalt\b/i,
];

export const READ_ONLY_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file, relative to the task root. Returns up to 64 KiB.',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to the task root.' } }, required: ['path'] },
  },
  {
    name: 'list_dir',
    description: 'List the entries (files and folders) of a directory relative to the task root.',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Directory path relative to the task root (use "." for the root).' } }, required: ['path'] },
  },
];

/** Resolve a requested path inside `root`, following symlinks, refusing any escape. */
async function resolveWithin(root: string, requested: unknown): Promise<string> {
  const escape = () => new Error('path escapes the task root');
  const rel = typeof requested === 'string' ? requested : '';
  const candidate = path.resolve(root, rel);
  // Lexical containment first (covers `..` before touching disk).
  if (candidate !== root && !candidate.startsWith(root + path.sep)) throw escape();

  // Compare against the REAL root, so a symlinked root still matches itself.
  const realRoot = await fs.realpath(root).catch(() => root);
  const inside = (p: string) => p === realRoot || p.startsWith(realRoot + path.sep);

  // The target often does not exist yet (write_file creates it). Resolving only
  // the full path would then silently fall back to the lexical one and follow a
  // symlink out of the root — e.g. `root/link -> /etc` plus `write_file(
  // "link/foo")` used to land in /etc. So walk up to the nearest EXISTING
  // ancestor, verify that after symlink resolution, and re-append the rest.
  const tail: string[] = [];
  let probe = candidate;
  for (;;) {
    const real = await fs.realpath(probe).catch(() => null);
    if (real !== null) {
      if (!inside(real)) throw escape();
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    }
    const parent = path.dirname(probe);
    if (parent === probe) throw escape(); // walked past the filesystem root
    tail.push(path.basename(probe));
    probe = parent;
  }
}

async function readFileTool(root: string, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    const target = await resolveWithin(root, input.path);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) return { content: `${input.path} is a directory; use list_dir.`, isError: true };
    const handle = await fs.open(target, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES, stat.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const truncated = stat.size > MAX_FILE_BYTES ? `\n\n[truncated: file is ${stat.size} bytes, showed first ${MAX_FILE_BYTES}]` : '';
      return { content: `${text}${truncated}` };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { content: error instanceof Error ? error.message : 'read_file failed', isError: true };
  }
}

async function listDirTool(root: string, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    const target = await resolveWithin(root, input.path);
    const entries = await fs.readdir(target, { withFileTypes: true });
    const lines = entries.slice(0, MAX_DIR_ENTRIES).map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'}  ${entry.name}`);
    const more = entries.length > MAX_DIR_ENTRIES ? `\n… ${entries.length - MAX_DIR_ENTRIES} more` : '';
    return { content: `${lines.join('\n')}${more}` || '(empty)' };
  } catch (error) {
    return { content: error instanceof Error ? error.message : 'list_dir failed', isError: true };
  }
}

export const WRITE_TOOL_SPEC: ToolSpec = {
  name: 'write_file',
  description: 'Create or overwrite a UTF-8 text file, relative to the task root. Parent folders inside the root are created as needed.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the task root.' },
      content: { type: 'string', description: 'Full new file contents.' },
    },
    required: ['path', 'content'],
  },
};

export const EXEC_TOOL_SPEC: ToolSpec = {
  name: 'run_shell',
  description: 'Run a shell command with the task root as working directory. Times out; output is capped. Use for build/test/inspection.',
  input_schema: { type: 'object', properties: { command: { type: 'string', description: 'The shell command to run.' } }, required: ['command'] },
};

async function writeFileTool(root: string, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    const content = typeof input.content === 'string' ? input.content : '';
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
      return { content: `refused: content exceeds ${MAX_WRITE_BYTES} bytes`, isError: true };
    }
    const target = await resolveWithin(root, input.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    return { content: `wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${input.path}` };
  } catch (error) {
    return { content: error instanceof Error ? error.message : 'write_file failed', isError: true };
  }
}

async function runShellTool(root: string, input: Record<string, unknown>): Promise<ToolResult> {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command) return { content: 'run_shell needs a command', isError: true };
  if (SHELL_DENYLIST.some((pattern) => pattern.test(command))) {
    return { content: 'refused: command matches a blocked destructive pattern', isError: true };
  }
  return new Promise<ToolResult>((resolve) => {
    // `detached` puts the command in its own process group so a timeout can
    // kill the WHOLE tree — spawn's built-in `timeout` only signals `sh` and
    // leaves its children running.
    const child = spawn('sh', ['-c', command], { cwd: root, detached: true });
    let out = '';
    let timedOut = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const append = (chunk: Buffer) => { if (out.length < SHELL_MAX_OUTPUT) out += chunk.toString('utf8'); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      const capped = out.length >= SHELL_MAX_OUTPUT ? `${out.slice(0, SHELL_MAX_OUTPUT)}\n[output truncated]` : out;
      const note = timedOut ? `\n[timed out after ${SHELL_TIMEOUT_MS}ms]` : '';
      resolve({ content: `exit ${code ?? 'null'}${note}\n${capped}`.trim(), isError: timedOut || (code ?? 1) !== 0 });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL'); // whole group
        else child.kill('SIGKILL');
      } catch { child.kill('SIGKILL'); }
      finish(null);
    }, SHELL_TIMEOUT_MS);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ content: `run_shell failed: ${error.message}`, isError: true });
    });

    // Resolve on 'exit' (the shell itself is done) rather than waiting for
    // 'close': if the command backgrounded anything, that grandchild keeps the
    // stdio pipes open and 'close' NEVER fires — which used to hang the whole
    // /kernel/run request for the lifetime of the orphan. A short grace lets
    // trailing output arrive on the normal path.
    child.on('close', (code) => finish(code));
    child.on('exit', (code) => {
      if (settled) return;
      graceTimer = setTimeout(() => finish(code), 200);
    });
  });
}

/**
 * Build the kernel tool executor bound to a task root. Read-only tools are
 * always present; write_file / run_shell are added AND enabled only when the
 * caller opts in for this run — the executor re-checks the flag as defense in
 * depth, so a model can't invoke a capability the run didn't grant.
 */
export function createKernelTools(root: string, caps: KernelCapabilities = {}): { specs: ToolSpec[]; execute: ToolExecutor } {
  const resolvedRoot = path.resolve(root);
  const allowWrite = Boolean(caps.allowWrite);
  const allowExec = Boolean(caps.allowExec);
  const specs: ToolSpec[] = [...READ_ONLY_TOOL_SPECS];
  if (allowWrite) specs.push(WRITE_TOOL_SPEC);
  if (allowExec) specs.push(EXEC_TOOL_SPEC);

  const execute: ToolExecutor = async (name, input) => {
    if (name === 'read_file') return readFileTool(resolvedRoot, input);
    if (name === 'list_dir') return listDirTool(resolvedRoot, input);
    if (name === 'write_file') {
      return allowWrite ? writeFileTool(resolvedRoot, input) : { content: 'write_file is not enabled for this run', isError: true };
    }
    if (name === 'run_shell') {
      return allowExec ? runShellTool(resolvedRoot, input) : { content: 'run_shell is not enabled for this run', isError: true };
    }
    return { content: `unknown tool: ${name}`, isError: true };
  };
  return { specs, execute };
}

/** Read-only tool set — the safe default (no write, no exec). */
export function createReadOnlyTools(root: string): { specs: ToolSpec[]; execute: ToolExecutor } {
  return createKernelTools(root, {});
}
