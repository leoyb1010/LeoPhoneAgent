import { describe, expect, it, vi } from 'vitest';

import {
  buildAfterEditPrompt,
  createAfterEditLabel,
  deterministicLabel,
  sanitizeLabel,
} from '../git-snapshot/gitSnapshotLabeler';

const diff = {
  diffStat: ' src/login.ts | 12 ++++++++\n src/api.ts | 3 +-\n 2 files changed',
  diffText: 'diff --git a/src/login.ts b/src/login.ts\n+export function validate() {}',
};

describe('gitSnapshotLabeler', () => {
  it('cleans model output into a compact label', () => {
    expect(sanitizeLabel('  "实现登录校验"。\nsecond line ')).toBe('实现登录校验');
    expect(sanitizeLabel('。。。')).toBe('');
    expect(sanitizeLabel('改'.repeat(80)).length).toBeLessThanOrEqual(30);
  });

  it('builds redacted bounded prompt context', () => {
    const prompt = buildAfterEditPrompt({
      diff: {
        diffStat: ' .env | 1 +',
        diffText:
          '+JWT_SECRET=supersecretvalue\n+const ACCESS_TOKEN = "anothersecretvalue"\n+export const API_KEY = "thirdsecretvalue"',
      },
      userPrompt: 'token ghp_abcdefghijklmnopqrstuvwxyzABCDE12345',
    });
    expect(prompt).toContain('[REDACTED');
    expect(prompt).not.toContain('supersecretvalue');
    expect(prompt).not.toContain('anothersecretvalue');
    expect(prompt).not.toContain('thirdsecretvalue');
    expect(prompt).not.toContain('ghp_abcdefghijklmnopqrstuvwxyzABCDE12345');
  });

  it('uses oneShot label when available', async () => {
    const oneShot = vi.fn().mockResolvedValue('"实现登录校验"');
    await expect(createAfterEditLabel({ diff }, { oneShot })).resolves.toBe('实现登录校验');
    expect(oneShot).toHaveBeenCalledOnce();
  });

  it('falls back to deterministic file label when oneShot fails or is empty', async () => {
    await expect(
      createAfterEditLabel({ diff }, { oneShot: vi.fn().mockRejectedValue(new Error('timeout')) }),
    ).resolves.toContain('login.ts');
    expect(deterministicLabel(' src/login.ts | 1 +\n test/login.ts | 1 +')).toBe('改动 login.ts');
    expect(deterministicLabel('')).toBe('保存改动');
  });
});
