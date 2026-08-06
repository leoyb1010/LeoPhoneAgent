import { describe, expect, it } from 'vitest';

import {
  extractKeywords,
  formatEvidenceBlock,
  truncateEvidence,
  type EvidenceItem,
} from '../evidence.pure';

const item = (text: string, i = 0): EvidenceItem => ({
  sessionId: `s${i}`,
  createdAt: 1750000000000 + i,
  text,
});

describe('truncateEvidence', () => {
  it('keeps items within budget untouched', () => {
    const r = truncateEvidence([item('hello'), item('world', 1)]);
    expect(r.items).toHaveLength(2);
    expect(r.droppedCount).toBe(0);
    expect(r.items[0].text).toBe('hello');
  });

  it('clips a single over-cap item and marks truncation', () => {
    const r = truncateEvidence([item('x'.repeat(100))], { perHitCharCap: 10 });
    expect(r.items[0].text).toBe(`${'x'.repeat(10)}\n[...truncated]`);
  });

  it('drops trailing items over the total budget and counts them', () => {
    const r = truncateEvidence(
      [item('a'.repeat(50)), item('b'.repeat(50), 1), item('c'.repeat(50), 2)],
      { perHitCharCap: 100, totalCharBudget: 110 },
    );
    expect(r.items).toHaveLength(2);
    expect(r.droppedCount).toBe(1);
  });

  it('handles empty input', () => {
    expect(truncateEvidence([])).toEqual({ items: [], droppedCount: 0 });
  });
});

describe('extractKeywords', () => {
  it('splits hyphenated names and picks words from the description', () => {
    const q = extractKeywords('git-workflow', 'Manage branches and pull requests on GitHub');
    expect(q).toContain('git');
    expect(q).toContain('workflow');
    expect(q).toContain('branches');
  });

  it('dedupes case-insensitively and respects the cap', () => {
    const q = extractKeywords('foo-foo', 'Foo FOO bar baz qux quux corge grault garply waldo fred plugh');
    const words = q.split(' ');
    expect(new Set(words.map((w) => w.toLowerCase())).size).toBe(words.length);
    expect(words.length).toBeLessThanOrEqual(12);
  });

  it('extracts CJK runs', () => {
    const q = extractKeywords('deploy', '发布流程与灰度策略');
    expect(q).toContain('发布流程与灰度策略');
  });
});

describe('formatEvidenceBlock', () => {
  it('returns empty string for no items', () => {
    expect(formatEvidenceBlock({ items: [], droppedCount: 0 })).toBe('');
  });

  it('renders numbered sections with dates and a dropped note', () => {
    const block = formatEvidenceBlock({
      items: [item('User: how do I deploy?')],
      droppedCount: 2,
    });
    expect(block).toContain('--- Evidence 1 (from a local session on ');
    expect(block).toContain('User: how do I deploy?');
    expect(block).toContain('2 more matching excerpt(s) omitted');
  });
});
