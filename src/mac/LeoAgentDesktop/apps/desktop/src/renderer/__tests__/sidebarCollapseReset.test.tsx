// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SECTION_COLLAPSE_DURATION_MS } from '../features/cc-agent/sidebar/SectionCollapse';
import { useCollapsibleShowAll } from '../features/cc-agent/sidebar/hooks/useCollapsibleShowAll';

function renderShowAll(initialCollapsed = false) {
  const rendered = renderHook(
    ({ sectionCollapsed }) => {
      const [showAll, setShowAll] = useCollapsibleShowAll(sectionCollapsed);
      return { showAll, setShowAll };
    },
    { initialProps: { sectionCollapsed: initialCollapsed } },
  );
  // 模拟用户点过「显示全部」——复位逻辑只在 showAll=true 时有意义。
  act(() => {
    rendered.result.current.setShowAll(true);
  });
  return rendered;
}

describe('useCollapsibleShowAll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('keeps showAll during the collapse animation and resets after it ends', () => {
    const { result, rerender } = renderShowAll();

    expect(result.current.showAll).toBe(true);

    rerender({ sectionCollapsed: true });
    expect(result.current.showAll).toBe(true);

    act(() => {
      vi.advanceTimersByTime(SECTION_COLLAPSE_DURATION_MS - 1);
    });
    expect(result.current.showAll).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.showAll).toBe(false);
  });

  it('cancels the pending reset if the section reopens before the animation ends', () => {
    const { result, rerender } = renderShowAll();

    rerender({ sectionCollapsed: true });
    act(() => {
      vi.advanceTimersByTime(SECTION_COLLAPSE_DURATION_MS / 2);
    });
    rerender({ sectionCollapsed: false });
    act(() => {
      vi.advanceTimersByTime(SECTION_COLLAPSE_DURATION_MS);
    });

    expect(result.current.showAll).toBe(true);
  });

  it('does not reset while the section itself never collapses', () => {
    const { result } = renderShowAll();

    act(() => {
      vi.advanceTimersByTime(SECTION_COLLAPSE_DURATION_MS * 2);
    });

    expect(result.current.showAll).toBe(true);
  });
});
