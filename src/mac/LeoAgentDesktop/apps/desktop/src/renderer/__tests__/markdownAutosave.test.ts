/**
 * markdownAutosave 调度器单测:debounce 语义与 trailing save 回归。
 * 核心回归:定时器到期时保存在途(isSaving=true)必须重排补发,而不是丢弃
 * ——否则"最后一批修改撞上在途保存"会让 dirty 悬挂到用户下次按键,期间
 * 崩溃即丢字。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMarkdownAutosave,
  normalizeBaseline,
} from '../features/cc-agent/workdir-browse/lib/markdownAutosave';

const DELAY = 900;

describe('createMarkdownAutosave', () => {
  let saving: boolean;
  let saveCalls: number;

  const make = () =>
    createMarkdownAutosave({
      delayMs: DELAY,
      isSaving: () => saving,
      save: () => {
        saveCalls++;
      },
    });

  beforeEach(() => {
    vi.useFakeTimers();
    saving = false;
    saveCalls = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires save exactly once after the debounce delay', () => {
    const autosave = make();
    autosave.schedule();
    vi.advanceTimersByTime(DELAY - 1);
    expect(saveCalls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(saveCalls).toBe(1);
    vi.advanceTimersByTime(DELAY * 3);
    expect(saveCalls).toBe(1);
  });

  it('consecutive schedule() calls reset the timer (debounce)', () => {
    const autosave = make();
    autosave.schedule();
    vi.advanceTimersByTime(DELAY - 100);
    autosave.schedule();
    vi.advanceTimersByTime(DELAY - 100);
    expect(saveCalls).toBe(0);
    vi.advanceTimersByTime(100);
    expect(saveCalls).toBe(1);
  });

  it('reschedules (not drops) when a save is in flight, then fires the trailing save', () => {
    const autosave = make();
    autosave.schedule();
    saving = true;
    // 到期时在途:不 save,重排。
    vi.advanceTimersByTime(DELAY);
    expect(saveCalls).toBe(0);
    // 仍在途:继续重排,不忙等、不丢。
    vi.advanceTimersByTime(DELAY);
    expect(saveCalls).toBe(0);
    // 在途结束 → 下一轮触发补发(trailing save)。
    saving = false;
    vi.advanceTimersByTime(DELAY);
    expect(saveCalls).toBe(1);
  });

  it('cancel() stops a pending timer and is idempotent', () => {
    const autosave = make();
    autosave.schedule();
    autosave.cancel();
    autosave.cancel();
    vi.advanceTimersByTime(DELAY * 2);
    expect(saveCalls).toBe(0);
    // cancel 后可重新 schedule。
    autosave.schedule();
    vi.advanceTimersByTime(DELAY);
    expect(saveCalls).toBe(1);
  });

  it('cancel() during an in-flight reschedule loop stops the trailing save', () => {
    const autosave = make();
    autosave.schedule();
    saving = true;
    vi.advanceTimersByTime(DELAY);
    autosave.cancel();
    saving = false;
    vi.advanceTimersByTime(DELAY * 2);
    expect(saveCalls).toBe(0);
  });
});

describe('normalizeBaseline', () => {
  it('normalizes CRLF to LF', () => {
    expect(normalizeBaseline('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('returns the same reference when no \\r present (zero-alloc fast path)', () => {
    const s = 'a\nb\n';
    expect(normalizeBaseline(s)).toBe(s);
  });

  it('makes LF editor value comparable against a CRLF disk baseline', () => {
    const disk = '# 标题\r\n正文\r\n';
    const editorValue = '# 标题\n正文\n'; // CodeMirror 文档行尾恒为 LF
    expect(editorValue === normalizeBaseline(disk)).toBe(true);
  });
});
