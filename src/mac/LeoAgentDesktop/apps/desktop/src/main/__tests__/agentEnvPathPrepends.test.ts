import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AuthAdapter } from '../../../../../packages/maker-core/src/interfaces/auth-adapter';
import { buildClaudeEnv } from '../../../../../packages/maker-core/src/agents/claude-code/env-builder';
import { buildCodexEnv } from '../../../../../packages/maker-core/src/agents/codex/env-builder';

function makeAuth(authEnv: Record<string, string>): AuthAdapter {
  return {
    getState: async () => ({ authenticated: true }),
    triggerLogin: async () => ({ authenticated: true }),
    logout: async () => undefined,
    getAuthEnv: async () => authEnv,
  };
}

async function withProcessEnv<T>(
  env: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const original = { ...process.env };
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, env);

  try {
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, original);
  }
}

function pathKey(): string {
  return process.platform === 'win32' ? 'Path' : 'PATH';
}

function bundledToolDir(): string {
  return process.platform === 'win32' ? 'C:\\xdt-maker\\tools\\ripgrep' : '/xdt-maker/tools/ripgrep';
}

function systemPath(): string {
  return process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin';
}

describe('agent env PATH prepends', () => {
  it('prepends bundled tools only in the Codex env object and preserves other env values', async () => {
    const key = pathKey();
    const originalPath = systemPath();
    const toolDir = bundledToolDir();

    await withProcessEnv({ [key]: originalPath, XDT_KEEP: 'keep' }, async () => {
      const env = await buildCodexEnv(makeAuth({ CODEX_HOME: 'C:\\codex-home' }), {
        behaviorFlags: { XDT_FLAG: '1' },
        pathPrepends: [toolDir],
      });

      expect(process.env[key]).toBe(originalPath);
      expect(env.XDT_KEEP).toBe('keep');
      expect(env.XDT_FLAG).toBe('1');
      expect(env.CODEX_HOME).toBe('C:\\codex-home');
      expect(env[key]?.split(path.delimiter)[0]).toBe(toolDir);
      expect(env[key]?.split(path.delimiter)[1]).toBe(originalPath);
    });
  });

  it('does not apply pathPrepends to Claude env assembly', async () => {
    const key = pathKey();
    const originalPath = systemPath();

    await withProcessEnv({ [key]: originalPath, XDT_KEEP: 'keep' }, async () => {
      const env = await buildClaudeEnv(makeAuth({ ANTHROPIC_API_KEY: 'injected' }), {
        pathPrepends: [bundledToolDir()],
      });

      expect(process.env[key]).toBe(originalPath);
      expect(env[key]).toBe(originalPath);
      expect(env.XDT_KEEP).toBe('keep');
      expect(env.ANTHROPIC_API_KEY).toBe('injected');
    });
  });
});
