import { describe, expect, it, vi } from 'vitest';

import { createWindowsClosePromptFallbackController } from '../windowsClosePromptFallback';

function createHarness() {
  let behavior: 'quit' | 'tray' | null = null;
  let scheduledCallback: (() => void) | null = null;
  const deps = {
    readBehavior: vi.fn(() => behavior),
    showRendererPrompt: vi.fn(),
    showNativePrompt: vi.fn(() => 'tray' as const),
    persistBehavior: vi.fn((next: 'quit' | 'tray') => {
      behavior = next;
    }),
    applyBehavior: vi.fn(),
    schedule: vi.fn((callback: () => void) => {
      scheduledCallback = callback;
      return 42;
    }),
    cancel: vi.fn(),
  };
  return {
    deps,
    controller: createWindowsClosePromptFallbackController(deps, 2_000),
    fireFallback: () => scheduledCallback?.(),
    setBehavior: (next: 'quit' | 'tray' | null) => {
      behavior = next;
    },
  };
}

describe('Windows close prompt fallback', () => {
  it('cancels the native fallback when the renderer confirms the dialog mounted', () => {
    const harness = createHarness();

    harness.controller.request();
    harness.controller.acknowledge();

    expect(harness.deps.showRendererPrompt).toHaveBeenCalledTimes(1);
    expect(harness.deps.schedule).toHaveBeenCalledWith(expect.any(Function), 2_000);
    expect(harness.deps.cancel).toHaveBeenCalledWith(42);
    expect(harness.deps.showNativePrompt).not.toHaveBeenCalled();
  });

  it('persists and applies the native fallback choice when no renderer ACK arrives', () => {
    const harness = createHarness();

    harness.controller.request();
    harness.fireFallback();

    expect(harness.deps.showNativePrompt).toHaveBeenCalledTimes(1);
    expect(harness.deps.persistBehavior).toHaveBeenCalledWith('tray');
    expect(harness.deps.applyBehavior).toHaveBeenCalledWith('tray');
  });

  it('does not prompt natively if another path configured the behavior before timeout', () => {
    const harness = createHarness();

    harness.controller.request();
    harness.setBehavior('quit');
    harness.fireFallback();

    expect(harness.deps.showNativePrompt).not.toHaveBeenCalled();
    expect(harness.deps.applyBehavior).not.toHaveBeenCalled();
  });

  it('keeps one fallback timer across repeated native close requests', () => {
    const harness = createHarness();

    harness.controller.request();
    harness.controller.request();

    expect(harness.deps.showRendererPrompt).toHaveBeenCalledTimes(2);
    expect(harness.deps.schedule).toHaveBeenCalledTimes(1);
  });
});
