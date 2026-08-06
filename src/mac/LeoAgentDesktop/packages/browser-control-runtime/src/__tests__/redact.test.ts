import { describe, expect, it } from 'vitest';

import { redactSensitiveText } from '../shim/_local/redact.js';

describe('redactSensitiveText', () => {
  it('masks bearer tokens', () => {
    const out = redactSensitiveText('Authorization: Bearer abcdef1234567890');
    expect(out).not.toContain('abcdef1234567890');
    expect(out).toContain('[redacted]');
  });

  it('masks a JWT (three base64url segments)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    expect(redactSensitiveText(`session=${jwt} end`)).not.toContain(jwt);
  });

  it('masks Google API keys and OAuth access tokens', () => {
    expect(redactSensitiveText('key=AIzaSyA1234567890abcdefghijKLMNOP')).not.toContain('AIzaSyA');
    expect(redactSensitiveText('tok ya29.a0AfH6SMBxyz1234567890')).not.toContain('ya29.a0');
  });

  it('masks Slack app-level (xapp) tokens', () => {
    expect(redactSensitiveText('xapp-1-A012345678XYZ')).toContain('[redacted]');
  });

  it('leaves ordinary text untouched', () => {
    const plain = 'hello world see https://example.com/path for details';
    expect(redactSensitiveText(plain)).toBe(plain);
  });
});
