import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('assert-codex-proxy-e2e script entrypoint', () => {
  it('runs its CLI main when invoked by node on Windows-style paths', () => {
    const scriptPath = resolve(__dirname, '..', '..', '..', 'scripts', 'assert-codex-proxy-e2e.mjs');

    const output = execFileSync(process.execPath, [scriptPath, '--help'], {
      encoding: 'utf8',
    });

    expect(output).toContain('Assert codex-proxy E2E logs.');
    expect(output).toContain('--body-dump <path>');
  });
});
