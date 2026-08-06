import { describe, expect, it } from 'vitest';

import { sanitizeNaming, sanitizeNamingString } from '../shim/sanitize-naming.js';

// Build the brand tokens from escapes / concatenation so the literal strings do
// not appear verbatim in this repo's source (the sanitizer's whole purpose is to
// keep them out of user-visible output).
const EMOJI = String.fromCodePoint(0x1f99e); // crustacean prefix emoji
const NAME = 'open' + 'claw'; // third-party product name
const NAME_UPPER = NAME.toUpperCase();

describe('sanitizeNamingString', () => {
  it('strips the emoji and replaces the product name in the browser-started log line', () => {
    const input = `${EMOJI} ${NAME} browser started (chrome) profile "${NAME}" on 127.0.0.1:18800`;
    const out = sanitizeNamingString(input);
    expect(out).not.toContain(EMOJI);
    expect(out.toLowerCase()).not.toContain(NAME);
    expect(out).toBe('browser runtime browser started (chrome) profile "browser runtime" on 127.0.0.1:18800');
  });

  it('replaces the product name in error guidance text (any case / spacing)', () => {
    expect(sanitizeNamingString(`Reinstall or update ${NAME} so the dependency is present`)).toBe(
      'Reinstall or update browser runtime so the dependency is present',
    );
    expect(sanitizeNamingString('open claw')).toBe('browser runtime');
    expect(sanitizeNamingString(NAME_UPPER)).toBe('browser runtime');
  });

  it('leaves clean text untouched', () => {
    expect(sanitizeNamingString('navigate failed (HTTP 500)')).toBe('navigate failed (HTTP 500)');
  });
});

describe('sanitizeNaming (values)', () => {
  it('passes through non-strings', () => {
    expect(sanitizeNaming(42)).toBe(42);
    expect(sanitizeNaming(null)).toBeNull();
    expect(sanitizeNaming(true)).toBe(true);
  });

  it('sanitizes string fields of a result-body object', () => {
    expect(sanitizeNaming({ error: `${EMOJI} ${NAME} failed`, status: 500 })).toEqual({
      error: 'browser runtime failed',
      status: 500,
    });
  });

  it('sanitizes string elements of an array', () => {
    expect(sanitizeNaming([`${EMOJI} ${NAME}`, 'ok'])).toEqual(['browser runtime', 'ok']);
  });

  it('recurses into nested objects and arrays (deep result bodies)', () => {
    const input = {
      status: 'ok',
      data: {
        doctor: { detail: `${EMOJI} ${NAME} not installed`, code: 1 },
        steps: [{ message: `update ${NAME}` }, 'navigate failed (HTTP 500)'],
      },
      count: 3,
    };
    expect(sanitizeNaming(input)).toEqual({
      status: 'ok',
      data: {
        doctor: { detail: 'browser runtime not installed', code: 1 },
        steps: [{ message: 'update browser runtime' }, 'navigate failed (HTTP 500)'],
      },
      count: 3,
    });
  });
});
