import { describe, expect, it } from 'vitest';

import { normalizeDisplayCommand } from '../commandDisplay';

describe('normalizeDisplayCommand', () => {
  it.each([
    ["/bin/zsh -lc 'git status --short'", 'git status --short'],
    ['/usr/bin/bash -c "gh pr checks 123"', 'gh pr checks 123'],
    ["/usr/bin/env zsh -lc 'pnpm test'", 'pnpm test'],
    ['/bin/zsh -lc pwd', 'pwd'],
    ['"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "pnpm test"', 'pnpm test'],
    ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -c Get-Location', 'Get-Location'],
    ['cmd.exe /c "git status --short"', 'git status --short'],
    ['cmd /C pnpm test', 'pnpm test'],
  ])('unwraps a known shell launcher: %s', (raw, expected) => {
    expect(normalizeDisplayCommand(raw)).toBe(expected);
  });

  it.each([
    'git status',
    "/bin/zsh -lc 'git status' extra",
    "/bin/zsh -lc 'git status",
    "/tmp/zsh -lc 'git status'",
    String.raw`/bin/zsh -lc git\ status`,
    String.raw`/bin/zsh -lc echo;rm`,
    'pwsh -Command "pnpm test"',
    'cmd.exe /k git status',
  ])('keeps non-wrapper or ambiguous input untouched by returning null: %s', (raw) => {
    expect(normalizeDisplayCommand(raw)).toBeNull();
  });
});
