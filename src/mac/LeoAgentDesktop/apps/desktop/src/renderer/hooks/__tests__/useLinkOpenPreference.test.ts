// @vitest-environment jsdom

/**
 * useLinkOpenPreference — 覆盖 override 语义(规则 20):
 *  - 默认 'sidebar';localStorage 只存 override
 *  - 选 'external' → 写入;选回 'sidebar' → 删除 key(清 override)
 *  - 非法存储值回落默认
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  _resetLinkOpenPreferenceForTests,
  getLinkOpenPreference,
  useLinkOpenPreference,
} from '../useLinkOpenPreference';

const KEY = 'chat.linkOpenPreference';

describe('useLinkOpenPreference', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetLinkOpenPreferenceForTests();
  });

  it('defaults to sidebar with no stored override', () => {
    expect(getLinkOpenPreference()).toBe('sidebar');
    const { result } = renderHook(() => useLinkOpenPreference());
    expect(result.current.preference).toBe('sidebar');
    expect(result.current.isCustomized).toBe(false);
  });

  it('reads a stored external override', () => {
    localStorage.setItem(KEY, 'external');
    expect(getLinkOpenPreference()).toBe('external');
    const { result } = renderHook(() => useLinkOpenPreference());
    expect(result.current.isCustomized).toBe(true);
  });

  it('falls back to default on garbage stored value', () => {
    localStorage.setItem(KEY, 'whatever');
    expect(getLinkOpenPreference()).toBe('sidebar');
  });

  it('setting external persists override; setting back to sidebar removes the key', () => {
    const { result } = renderHook(() => useLinkOpenPreference());
    act(() => result.current.setPreference('external'));
    expect(localStorage.getItem(KEY)).toBe('external');
    expect(getLinkOpenPreference()).toBe('external');

    act(() => result.current.setPreference('sidebar'));
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(getLinkOpenPreference()).toBe('sidebar');
    expect(result.current.isCustomized).toBe(false);
  });
});
