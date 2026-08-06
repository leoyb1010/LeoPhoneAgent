import { describe, expect, it } from 'vitest';

import { getPlaintextEditorChrome } from '../components/markdown/plaintextEditorChrome';

describe('PlaintextEditor — unknown code language chrome fallback', () => {
  it('uses code chrome for non-markdown language intent regardless of parser support', () => {
    expect(getPlaintextEditorChrome('definitely-unsupported-language')).toBe('code');
    expect(getPlaintextEditorChrome('makefile')).toBe('code');
  });

  it('keeps markdown aliases on markdown chrome', () => {
    expect(getPlaintextEditorChrome('markdown')).toBe('markdown');
    expect(getPlaintextEditorChrome('md')).toBe('markdown');
  });

  it('uses plain chrome when no language is provided', () => {
    expect(getPlaintextEditorChrome(undefined)).toBe('plain');
  });
});
