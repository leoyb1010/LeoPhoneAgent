import { describe, expect, it } from 'vitest';

import { extractBrowserAvailability } from '../browser-availability.js';

describe('extractBrowserAvailability', () => {
  it('reports detected when the runtime status carries an executable path', () => {
    const result = extractBrowserAvailability({
      detectedBrowser: 'chrome',
      detectedExecutablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    expect(result).toEqual({
      detected: true,
      browserKind: 'chrome',
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
  });

  it('reports not detected when no executable path is present', () => {
    expect(extractBrowserAvailability({ detectedBrowser: null, detectedExecutablePath: null })).toEqual({
      detected: false,
      browserKind: null,
      executablePath: null,
    });
  });

  it('treats empty strings as not detected', () => {
    expect(extractBrowserAvailability({ detectedBrowser: '', detectedExecutablePath: '' })).toEqual({
      detected: false,
      browserKind: null,
      executablePath: null,
    });
  });

  it('tolerates missing / malformed status payloads', () => {
    expect(extractBrowserAvailability(undefined).detected).toBe(false);
    expect(extractBrowserAvailability(null).detected).toBe(false);
    expect(extractBrowserAvailability({}).detected).toBe(false);
    expect(extractBrowserAvailability({ detectedExecutablePath: 123 }).detected).toBe(false);
  });
});
