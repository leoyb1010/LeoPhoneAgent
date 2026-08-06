import { describe, expect, it } from 'vitest';

import { createWorkerLabel, shouldShowWorkerLabel } from '../features/cc-agent/workerLabel';

describe('worker label helpers', () => {
  it('generates stable labels from role names', () => {
    expect(createWorkerLabel('reviewer', [])).toBe('reviewer');
    expect(createWorkerLabel('Code Review', [])).toBe('code-review');
    expect(createWorkerLabel('评审', [])).toBe('worker');
  });

  it('deduplicates generated labels', () => {
    expect(createWorkerLabel('developer', ['developer'])).toBe('developer-2');
    expect(createWorkerLabel('developer', ['developer', 'developer-2'])).toBe('developer-3');
  });

  it('hides labels that duplicate the role', () => {
    expect(shouldShowWorkerLabel('developer', 'developer')).toBe(false);
    expect(shouldShowWorkerLabel('developer', 'developer-2')).toBe(true);
    expect(shouldShowWorkerLabel('developer', null)).toBe(false);
  });
});
