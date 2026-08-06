import { describe, expect, it } from 'vitest';

import { unquoteFontFamily } from '@/components/settings/fontFamilyValue';

describe('unquoteFontFamily', () => {
  it('strips surrounding double quotes for trigger labels', () => {
    // Regression: a stored value like `"PingFang SC"` used to render the literal
    // quotes in the trigger button. The label must be clean.
    expect(unquoteFontFamily('"PingFang SC"')).toBe('PingFang SC');
  });

  it('strips surrounding single quotes', () => {
    expect(unquoteFontFamily("'Comic Sans MS'")).toBe('Comic Sans MS');
  });

  it('leaves unquoted values (plain names / var()) untouched', () => {
    expect(unquoteFontFamily('Menlo')).toBe('Menlo');
    expect(unquoteFontFamily('var(--app-font-code-default)')).toBe('var(--app-font-code-default)');
  });

  it('unescapes quoted values', () => {
    expect(unquoteFontFamily('"Weird \\"Font\\" \\\\ Name"')).toBe('Weird "Font" \\ Name');
  });
});
