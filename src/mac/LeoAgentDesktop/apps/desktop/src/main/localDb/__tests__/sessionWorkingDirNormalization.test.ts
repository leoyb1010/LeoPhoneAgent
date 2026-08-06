import { describe, expect, it } from 'vitest';

import { sessionCreateToRow, sessionPatchToRow } from '../mapper';

describe('session workingDir normalization', () => {
  const now = 1_700_000_000_000;

  it('normalizes Windows separators and trailing slash on create', () => {
    const row = sessionCreateToRow('id1', { workingDir: 'D:\\Project-001\\' }, now);

    expect(row.workingDir).toBe('D:/Project-001');
  });

  it('normalizes Windows separators and trailing slash on patch', () => {
    const patch = sessionPatchToRow({ workingDir: 'D:\\Project-001\\' });

    expect(patch.workingDir).toBe('D:/Project-001');
  });

  it('keeps blank workingDir as null', () => {
    expect(sessionCreateToRow('id2', { workingDir: '   ' }, now).workingDir).toBeNull();
    expect(sessionPatchToRow({ workingDir: '   ' }).workingDir).toBeNull();
  });
});
