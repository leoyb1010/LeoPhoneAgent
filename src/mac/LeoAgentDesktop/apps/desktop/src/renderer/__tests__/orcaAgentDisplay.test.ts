import { describe, expect, it } from 'vitest';

import {
  normalizeOrcaDisplayAgentKind,
  orcaAgentLabel,
  orcaVendorForAgentKind,
} from '@/features/cc-agent/lib/orcaAgentDisplay';

describe('orca agent display fallback', () => {
  it('normalizes explicit Orca agent kinds', () => {
    expect(normalizeOrcaDisplayAgentKind('codex')).toBe('codex');
    expect(normalizeOrcaDisplayAgentKind('cc')).toBe('claude-code');
    expect(normalizeOrcaDisplayAgentKind('claude-code')).toBe('claude-code');
  });

  it('falls back to Claude when agentKind is missing or invalid', () => {
    expect(normalizeOrcaDisplayAgentKind(undefined)).toBe('claude-code');
    expect(normalizeOrcaDisplayAgentKind(null)).toBe('claude-code');
    expect(normalizeOrcaDisplayAgentKind('bad')).toBe('claude-code');
  });

  it('formats display label and VendorIcon vendor from the normalized kind', () => {
    expect(orcaAgentLabel('codex')).toBe('Codex');
    expect(orcaAgentLabel('claude-code')).toBe('Claude');
    expect(orcaVendorForAgentKind('codex')).toBe('codex');
    expect(orcaVendorForAgentKind('claude-code')).toBe('cc');
  });
});
