import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the vendored in-process dispatcher so we can drive controlled
// (status, body) responses and assert WHERE the brand scrubber applies.
const dispatchMock = vi.fn();
vi.mock('../_generated/extension/src/browser/local-dispatch.runtime.js', () => ({
  dispatchBrowserControlRequest: (...args: unknown[]) => dispatchMock(...args),
}));

import { createBrowserControlRuntime } from '../runtime.js';

describe('runtime sanitization scope', () => {
  beforeEach(() => dispatchMock.mockReset());

  it('returns SUCCESS data verbatim — does not scrub page content containing the vendored brand', async () => {
    // A page/extract result that legitimately mentions the brand must reach the
    // agent unchanged; scrubbing it here corrupts real data.
    dispatchMock.mockResolvedValue({ status: 200, body: { text: 'See openclaw 🦞 for details' } });
    const rt = createBrowserControlRuntime({ config: { browser: { enabled: true } } });

    const res = await rt.call({ action: 'snapshot', targetId: 't1' });

    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ text: 'See openclaw 🦞 for details' });
  });

  it('scrubs the brand from ERROR bodies and the error message (runtime-owned text)', async () => {
    dispatchMock.mockResolvedValue({ status: 500, body: { error: 'openclaw runtime crashed' } });
    const rt = createBrowserControlRuntime({ config: { browser: { enabled: true } } });

    const res = await rt.call({ action: 'snapshot', targetId: 't1' });

    expect(res.ok).toBe(false);
    expect(JSON.stringify(res.data)).not.toContain('openclaw');
    expect(res.message).not.toContain('openclaw');
  });

  it('scrubs the brand from SUCCESS bodies of runtime-owned diagnostics (profiles/status/doctor)', async () => {
    // Unlike page content, profiles/status/doctor success bodies are the runtime's
    // own identity text — driver labels, fix hints — which carry the vendored name.
    const rt = createBrowserControlRuntime({ config: { browser: { enabled: true } } });

    dispatchMock.mockResolvedValue({ status: 200, body: { profiles: [{ name: 'XDMaker', driver: 'openclaw' }] } });
    const profiles = await rt.call({ action: 'profiles' });
    expect(profiles.ok).toBe(true);
    expect(JSON.stringify(profiles.data)).not.toContain('openclaw');

    dispatchMock.mockResolvedValue({ status: 200, body: { fixHint: 'Run openclaw 🦞 browser start' } });
    const doctor = await rt.call({ action: 'doctor' });
    expect(doctor.ok).toBe(true);
    expect(JSON.stringify(doctor.data)).not.toContain('openclaw');
    expect(JSON.stringify(doctor.data)).toContain('browser runtime');
  });
});
