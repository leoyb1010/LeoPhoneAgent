import { describe, expect, it } from 'vitest';

import { isBrowserOpenablePath } from '../../shared/browserOpenableExts';

describe('browserOpenableExts', () => {
  it('allows only html files for browser viewing', () => {
    expect(isBrowserOpenablePath('index.html')).toBe(true);
    expect(isBrowserOpenablePath('docs\\page.HTM')).toBe(true);
    expect(isBrowserOpenablePath('README.md')).toBe(false);
    expect(isBrowserOpenablePath('notes.txt')).toBe(false);
    expect(isBrowserOpenablePath('diagram.svg')).toBe(false);
    expect(isBrowserOpenablePath('image.png')).toBe(false);
    expect(isBrowserOpenablePath('.html')).toBe(false);
  });
});
