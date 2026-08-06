import { describe, expect, it } from 'vitest';

import { stripTerminalControlSequences } from './terminal-output.js';

describe('stripTerminalControlSequences', () => {
  it('strips ISO-2022 charset designation escape sequences as a unit', () => {
    expect(stripTerminalControlSequences(`reset\u001B(Bdone`)).toBe('resetdone');
  });

  it('normalizes CRLF and bare CR to LF for stable display text', () => {
    expect(stripTerminalControlSequences('one\r\ntwo\rthree\n')).toBe('one\ntwo\nthree\n');
  });
});
