import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected app path: ${name}`);
      return userDataDir;
    },
  },
}));

vi.mock('../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(userDataDir, ...parts),
}));

describe('dialogue workspace directory', () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-dialogues-'));
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('uses local calendar buckets under app userData/dialogues', async () => {
    const {
      buildDialogueWorkspaceDir,
      dialogueWorkspaceDayKey,
      dialogueWorkspaceRootDir,
    } = await import('../localDb/dialogueWorkspace');
    const now = new Date(2026, 4, 20, 12, 0, 0).getTime();

    expect(dialogueWorkspaceDayKey(now)).toBe('2026-05-20');
    expect(dialogueWorkspaceRootDir()).toBe(path.join(userDataDir, 'dialogues'));
    expect(buildDialogueWorkspaceDir('session-1', now)).toBe(
      path.join(userDataDir, 'dialogues', '2026-05-20', 'session-1'),
    );
  });

  it('creates the managed dialogue directory when requested', async () => {
    const { ensureDialogueWorkspaceDir } = await import('../localDb/dialogueWorkspace');
    const now = new Date(2026, 4, 20, 12, 0, 0).getTime();

    const dir = ensureDialogueWorkspaceDir('session-2', now);

    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(dir).toBe(path.join(userDataDir, 'dialogues', '2026-05-20', 'session-2'));
  });
});
