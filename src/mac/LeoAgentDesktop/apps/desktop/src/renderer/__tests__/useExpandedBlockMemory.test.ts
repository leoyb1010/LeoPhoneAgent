/**
 * useExpandedBlockMemory.test.ts
 * ---------------------------------------------------------------------------
 * Unit tests for the in-memory per-block expand state. State is intentionally
 * NOT persisted across reloads — these tests just verify the module-level
 * Set behaves correctly through `__test_internals`.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { __test_internals } from '../hooks/useExpandedBlockMemory';

describe('useExpandedBlockMemory — module store', () => {
  beforeEach(() => {
    __test_internals.reset();
  });

  it('default state is collapsed (false) for any block id', () => {
    expect(__test_internals.isExpanded('agent:foo')).toBe(false);
    expect(__test_internals.isExpanded('thinking:bar')).toBe(false);
  });

  it('setExpanded(true) flips state to expanded', () => {
    __test_internals.setExpanded('agent:abc', true);
    expect(__test_internals.isExpanded('agent:abc')).toBe(true);
  });

  it('setExpanded(false) reverts to the default collapsed state', () => {
    __test_internals.setExpanded('agent:foo', true);
    __test_internals.setExpanded('agent:foo', false);
    expect(__test_internals.isExpanded('agent:foo')).toBe(false);
  });

  it('multiple keys are tracked independently', () => {
    __test_internals.setExpanded('agent:a', true);
    __test_internals.setExpanded('thinking:b', true);
    __test_internals.setExpanded('agent:c', true);
    __test_internals.setExpanded('agent:c', false);

    expect(__test_internals.isExpanded('agent:a')).toBe(true);
    expect(__test_internals.isExpanded('thinking:b')).toBe(true);
    expect(__test_internals.isExpanded('agent:c')).toBe(false);
  });

  it('reset() clears all state', () => {
    __test_internals.setExpanded('agent:x', true);
    __test_internals.setExpanded('thinking:y', true);
    __test_internals.reset();
    expect(__test_internals.isExpanded('agent:x')).toBe(false);
    expect(__test_internals.isExpanded('thinking:y')).toBe(false);
  });
});
