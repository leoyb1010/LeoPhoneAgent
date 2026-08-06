import { describe, expect, it } from 'vitest';

import { resolveNewMakerMenuCommand } from '../applicationMenuCommands';

describe('resolveNewMakerMenuCommand', () => {
  it('keeps mouse menu clicks semantic and routes only accelerators contextually', () => {
    expect(resolveNewMakerMenuCommand(false)).toBe('new-maker');
    expect(resolveNewMakerMenuCommand(undefined)).toBe('new-maker');
    expect(resolveNewMakerMenuCommand(true)).toBe('new-maker-shortcut');
  });
});
