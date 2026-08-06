/**
 * dispatchSendClear.test.ts
 * ---------------------------------------------------------------------------
 * Regression test for: new-css-input-lost-on-workdir-select
 *
 * Verifies the dispatchSend contract: editor content is only cleared when
 * onSend does NOT return `false`. This mirrors the inline logic in
 * ChatInput.tsx's dispatchSend callback without requiring a full React render.
 */

import { describe, it, expect, vi } from 'vitest';

// ── Extracted dispatchSend logic ──────────────────────────────────────────
// This mirrors the core decision flow from ChatInput.tsx:858-870.
// We intentionally keep it as a standalone function to unit-test the
// "clear on send" contract independent of React / tiptap.

interface DispatchSendDeps {
  getText: () => string;
  hasAttachments: boolean;
  disabled: boolean;
  onSend: (text: string) => boolean | void;
  clearContent: () => void;
  clearFiles: () => void;
}

function dispatchSendLogic(deps: DispatchSendDeps): void {
  if (deps.disabled) return;
  const text = deps.getText();
  if (!text && !deps.hasAttachments) return;
  const result = deps.onSend(text);
  if (result === false) return;
  deps.clearContent();
  deps.clearFiles();
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('dispatchSend clear-content contract', () => {
  const makeDeps = (overrides: Partial<DispatchSendDeps> = {}): DispatchSendDeps => ({
    getText: () => 'hello world',
    hasAttachments: false,
    disabled: false,
    onSend: vi.fn(),
    clearContent: vi.fn(),
    clearFiles: vi.fn(),
    ...overrides,
  });

  it('clears editor when onSend returns void (normal send)', () => {
    const deps = makeDeps({ onSend: vi.fn(() => undefined) });
    dispatchSendLogic(deps);
    expect(deps.onSend).toHaveBeenCalledWith('hello world');
    expect(deps.clearContent).toHaveBeenCalledTimes(1);
    expect(deps.clearFiles).toHaveBeenCalledTimes(1);
  });

  it('clears editor when onSend returns true', () => {
    const deps = makeDeps({ onSend: vi.fn(() => true) });
    dispatchSendLogic(deps);
    expect(deps.clearContent).toHaveBeenCalledTimes(1);
    expect(deps.clearFiles).toHaveBeenCalledTimes(1);
  });

  it('does NOT clear editor when onSend returns false (send interrupted)', () => {
    const deps = makeDeps({ onSend: vi.fn(() => false) });
    dispatchSendLogic(deps);
    expect(deps.onSend).toHaveBeenCalledWith('hello world');
    expect(deps.clearContent).not.toHaveBeenCalled();
    expect(deps.clearFiles).not.toHaveBeenCalled();
  });

  it('does not send when disabled', () => {
    const deps = makeDeps({ disabled: true });
    dispatchSendLogic(deps);
    expect(deps.onSend).not.toHaveBeenCalled();
    expect(deps.clearContent).not.toHaveBeenCalled();
  });

  it('does not send when text is empty and no attachments', () => {
    const deps = makeDeps({ getText: () => '', hasAttachments: false });
    dispatchSendLogic(deps);
    expect(deps.onSend).not.toHaveBeenCalled();
    expect(deps.clearContent).not.toHaveBeenCalled();
  });

  it('sends when text is empty but has attachments', () => {
    const deps = makeDeps({ getText: () => '', hasAttachments: true, onSend: vi.fn() });
    dispatchSendLogic(deps);
    expect(deps.onSend).toHaveBeenCalledWith('');
    expect(deps.clearContent).toHaveBeenCalledTimes(1);
    expect(deps.clearFiles).toHaveBeenCalledTimes(1);
  });

  // Regression: slash commands return void → editor should clear
  it('clears editor for slash commands (onSend returns void)', () => {
    const deps = makeDeps({ getText: () => '/clear', onSend: vi.fn() });
    dispatchSendLogic(deps);
    expect(deps.clearContent).toHaveBeenCalledTimes(1);
  });

  // Regression: workingDir missing → onSend returns false → editor preserved
  it('preserves editor when workingDir is missing (simulated via return false)', () => {
    const deps = makeDeps({
      getText: () => 'some user input',
      onSend: vi.fn(() => false),
    });
    dispatchSendLogic(deps);
    expect(deps.onSend).toHaveBeenCalledWith('some user input');
    expect(deps.clearContent).not.toHaveBeenCalled();
    expect(deps.clearFiles).not.toHaveBeenCalled();
  });

  // Regression: API key missing → onSend returns false → editor preserved
  it('preserves editor when API key is missing (simulated via return false)', () => {
    const deps = makeDeps({
      getText: () => 'important message',
      onSend: vi.fn(() => false),
    });
    dispatchSendLogic(deps);
    expect(deps.clearContent).not.toHaveBeenCalled();
    expect(deps.clearFiles).not.toHaveBeenCalled();
  });
});
