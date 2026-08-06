// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '@/lib/makerChatStore';
import { absoluteToRepoRelative, collectLastTurnPaths } from '../useLastTurnFilter';

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    clientId: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    ...partial,
  } as ChatMessage;
}

describe('useLastTurnFilter path collection', () => {
  it('converts absolute paths to repo-relative paths', () => {
    expect(absoluteToRepoRelative('/repo/src/app.ts', '/repo')).toBe('src/app.ts');
    expect(absoluteToRepoRelative('/other/app.ts', '/repo')).toBeNull();
  });

  it('collects Codex file_change paths from absolute and repo-relative change entries', () => {
    const paths = collectLastTurnPaths([
      msg({ role: 'user', content: 'change files' }),
      msg({
        role: 'tool_use',
        toolName: 'file_change',
        toolInput: {
          changes: [
            { path: '/repo/src/absolute.ts', kind: { type: 'update' } },
            { path: 'src/relative.ts', kind: { type: 'add' } },
            { path: 'src/delete.ts', kind: { type: 'delete' } },
          ],
        },
      }),
    ], '/repo');

    expect([...paths].sort()).toEqual(['src/absolute.ts', 'src/delete.ts', 'src/relative.ts']);
  });

  it('collects defensive move path fields from Codex update changes', () => {
    const paths = collectLastTurnPaths([
      msg({ role: 'user', content: 'move files' }),
      msg({
        role: 'tool_use',
        toolName: 'file_change',
        toolInput: {
          changes: [
            { path: 'src/old.ts', kind: { type: 'update', move_path: 'src/new.ts' } },
            { path: 'docs/old.md', kind: { type: 'update', movePath: '/repo/docs/new.md' } },
          ],
        },
      }),
    ], '/repo');

    expect([...paths].sort()).toEqual(['docs/new.md', 'docs/old.md', 'src/new.ts', 'src/old.ts']);
  });

  it('only scans messages after the latest user turn', () => {
    const paths = collectLastTurnPaths([
      msg({ role: 'user', content: 'first' }),
      msg({ role: 'tool_use', toolName: 'file_change', toolInput: { changes: [{ path: 'old.ts' }] } }),
      msg({ role: 'user', content: 'second' }),
      msg({ role: 'tool_use', toolName: 'file_change', toolInput: { changes: [{ path: 'new.ts' }] } }),
    ], '/repo');

    expect([...paths]).toEqual(['new.ts']);
  });
});
