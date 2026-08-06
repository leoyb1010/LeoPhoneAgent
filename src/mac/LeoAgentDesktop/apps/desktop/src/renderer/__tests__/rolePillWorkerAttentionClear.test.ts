import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'RolePillDropdown.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('RolePillDropdown worker attention clearing', () => {
  it('clears selected worker attention before paint to avoid transient selected-worker dots', () => {
    const tabsBlock = extractBetween(
      source,
      'function WorkerTabsList({',
      'export function WorkerListToolbar({',
    );
    const dropdownBlock = source.slice(source.indexOf('export function RolePillDropdown({'));

    expect(tabsBlock).toContain('useLayoutEffect(() => {');
    expect(tabsBlock).toContain('if (!clearAttentionWhenVisible) return;');
    expect(tabsBlock).toContain('clearWorkerAttention(selectedWorkerId);');
    expect(dropdownBlock).toContain('useLayoutEffect(() => {');
    expect(dropdownBlock).toContain('if (!clearAttentionWhenVisible) return;');
    expect(dropdownBlock).toContain('clearWorkerAttention(selectedWorkerId);');
  });

  it('threads the visibility gate from WorkerListToolbar to both worker list layouts', () => {
    const toolbarBlock = extractBetween(
      source,
      'export function WorkerListToolbar({',
      'export function RolePillDropdown({',
    );

    expect(toolbarBlock).toContain('clearAttentionWhenVisible = true');
    expect(toolbarBlock).toContain('clearAttentionWhenVisible={clearAttentionWhenVisible}');
  });
});

function extractBetween(sourceText: string, startNeedle: string, endNeedle: string): string {
  const start = sourceText.indexOf(startNeedle);
  const end = sourceText.indexOf(endNeedle, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sourceText.slice(start, end);
}
