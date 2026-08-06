import { describe, expect, it } from 'vitest';

import { redactSensitive } from '../redaction';

describe('redactSensitive', () => {
  it('redacts vendor API keys', () => {
    const r = redactSensitive('use sk-abcdefghijklmnopqrstuvwx and ghp_ABCDEFGHIJKLMNOPQRST12');
    expect(r.text).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(r.text).not.toContain('ghp_ABCDEFGHIJKLMNOPQRST12');
    expect(r.text).toContain('[REDACTED:api-key]');
    expect(r.hitCount).toBe(2);
    expect(r.categories).toEqual(['api-key']);
  });

  it('redacts AWS / Slack / Google keys', () => {
    const r = redactSensitive('AKIAIOSFODNN7EXAMPLE xoxb-1234567890-abc AIzaSyA1234567890abcdefghijklmnopqrstu');
    expect(r.categories).toEqual(['api-key']);
    expect(r.hitCount).toBe(3);
  });

  it('redacts Bearer tokens but keeps the Bearer prefix', () => {
    const r = redactSensitive('Authorization: Bearer abc123def456ghi789jkl');
    expect(r.text).toContain('Bearer [REDACTED:bearer]');
  });

  it('redacts JWT three-part tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM';
    const r = redactSensitive(`token was ${jwt} ok`);
    expect(r.text).not.toContain(jwt);
    expect(r.categories).toContain('jwt');
  });

  it('redacts generic secret assignments (quoted and bare)', () => {
    const r = redactSensitive('api_key: "supersecretvalue123"\npassword=hunter2hunter2');
    expect(r.text).toContain('api_key: "[REDACTED:generic-secret]"');
    expect(r.text).toContain('password=[REDACTED:generic-secret]');
  });

  it('redacts prefixed secret env assignments', () => {
    const r = redactSensitive(
      'AWS_SECRET_ACCESS_KEY=awssecretvalue123\nSTRIPE_SECRET_KEY=stripestripe123\nMY_API_KEY=myapikeyvalue123',
    );
    expect(r.text).toContain('AWS_SECRET_ACCESS_KEY=[REDACTED:generic-secret]');
    expect(r.text).toContain('STRIPE_SECRET_KEY=[REDACTED:generic-secret]');
    expect(r.text).toContain('MY_API_KEY=[REDACTED:generic-secret]');
    expect(r.categories).toEqual(['generic-secret']);
  });

  it('does NOT redact code-shaped values after secret-ish keys', () => {
    const input = 'const token = fetchToken()\nsecret: process.env.MY_SECRET\napiKey: ${API_KEY}';
    const r = redactSensitive(input);
    expect(r.text).toBe(input);
    expect(r.hitCount).toBe(0);
  });

  it('rewrites home paths to ~ on all three platforms', () => {
    const r = redactSensitive('/Users/carol/Projects/foo /home/chris/work C:\\Users\\chris\\dev');
    expect(r.text).toBe('~/Projects/foo ~/work ~\\dev');
    expect(r.categories).toEqual(['home-path']);
  });

  it('rewrites Windows home paths written with forward slashes (file URLs / shell output)', () => {
    const r = redactSensitive('see C:/Users/alice/dev/tool.ps1 and file:///C:/Users/alice/x');
    expect(r.text).not.toContain('alice');
    expect(r.text).toContain('~/dev/tool.ps1');
  });

  it('swallows profile names with spaces when the path continues past the name', () => {
    const r = redactSensitive('log at C:\\Users\\John Smith\\AppData\\log.txt and /Users/Jane Doe/work/x');
    expect(r.text).toBe('log at ~\\AppData\\log.txt and ~/work/x');
    expect(r.text).not.toContain('John');
    expect(r.text).not.toContain('Jane');
  });

  it('does not over-eat prose following a home path', () => {
    const r = redactSensitive('/Users/alice went to /tmp for scratch space');
    expect(r.text).toBe('~ went to /tmp for scratch space');
  });

  it('redacts RFC1918 IPs and internal domains, keeps public hosts', () => {
    const r = redactSensitive('http://10.1.2.3:8080 and 192.168.0.1 and api.corp.internal but github.com stays');
    expect(r.text).toContain('github.com');
    expect(r.text).not.toContain('10.1.2.3');
    expect(r.text).not.toContain('192.168.0.1');
    expect(r.categories).toContain('internal-address');
  });

  it('redacts emails', () => {
    const r = redactSensitive('contact carol@example.com please');
    expect(r.text).toBe('contact [REDACTED:email] please');
  });

  it('is idempotent', () => {
    const once = redactSensitive('key sk-abcdefghijklmnopqrstuvwx from carol@example.com at /Users/carol/x');
    const twice = redactSensitive(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.hitCount).toBe(0);
  });

  it('returns empty input untouched', () => {
    expect(redactSensitive('')).toEqual({ text: '', hitCount: 0, categories: [] });
  });
});
