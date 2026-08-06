// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { getUserPrompt, setUserPromptOwner } from '@/lib/userPromptStore';

afterEach(() => {
  localStorage.clear();
  setUserPromptOwner(null);
});

describe('userPromptStore legacy migration', () => {
  it('imports the legacy prompt into the first owner namespace', () => {
    localStorage.setItem('userPrompt.value', 'legacy prompt');

    setUserPromptOwner('owner-a');

    expect(getUserPrompt()).toBe('legacy prompt');
    expect(localStorage.getItem('userPrompt.value.owner-a')).toBe('legacy prompt');
    expect(localStorage.getItem('userPrompt.value')).toBeNull();
  });

  it('does not overwrite an existing owner prompt', () => {
    localStorage.setItem('userPrompt.value', 'legacy prompt');
    localStorage.setItem('userPrompt.value.owner-a', 'owner prompt');

    setUserPromptOwner('owner-a');

    expect(getUserPrompt()).toBe('owner prompt');
    expect(localStorage.getItem('userPrompt.value')).toBe('legacy prompt');
  });
});
