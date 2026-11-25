// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeoSpeakAction, resetLeoSpeakActionStoreForTest } from "@/leo/LeoSpeakAction.js";
import type { LeoSpeechBridge } from "@/leo/leoSpeechBridge.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/components/ai-elements/message.js", () => ({
  MessageAction: ({
    children,
    label,
    onClick,
    ...rest
  }: {
    children?: ReactNode;
    label?: string;
    tooltip?: string;
    onClick?: () => void;
    "aria-label"?: string;
    "aria-pressed"?: boolean;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "speak-action",
        "aria-label": rest["aria-label"] ?? label,
        "aria-pressed": rest["aria-pressed"],
        onClick,
      },
      children,
    ),
}));

function installMockSpeechBridge() {
  let speakStateCb: ((state: { speaking: boolean }) => void) | null = null;
  const unsubscribe = vi.fn();
  const bridge: LeoSpeechBridge = {
    getSettings: vi.fn(async () => ({
      available: true,
      settings: { dictationEnabled: true, accelerator: "Alt+Backquote", readAloudEnabled: true },
    })),
    setSettings: vi.fn(async (patch) => ({
      available: true,
      settings: {
        dictationEnabled: patch.dictationEnabled ?? true,
        accelerator: patch.accelerator ?? "Alt+Backquote",
        readAloudEnabled: patch.readAloudEnabled ?? true,
      },
    })),
    start: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => undefined),
    prewarm: vi.fn(async () => undefined),
    speak: vi.fn(async () => ({ ok: true })),
    stopSpeaking: vi.fn(async () => undefined),
    openMicSettings: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => undefined),
    onSpeakState: vi.fn((cb: (state: { speaking: boolean }) => void) => {
      speakStateCb = cb;
      return unsubscribe;
    }),
  };
  (window as unknown as { leoSpeech?: LeoSpeechBridge }).leoSpeech = bridge;
  return {
    bridge,
    unsubscribe,
    emitSpeakState: (speaking: boolean) => speakStateCb?.({ speaking }),
  };
}

describe("LeoSpeakAction shared subscription stability (Round 3 P0-1)", () => {
  beforeEach(() => {
    resetLeoSpeakActionStoreForTest();
  });

  afterEach(() => {
    cleanup();
    resetLeoSpeakActionStoreForTest();
    delete (window as unknown as { leoSpeech?: LeoSpeechBridge }).leoSpeech;
  });

  it("mounts 1 instance without infinite re-subscribe / IPC loop", async () => {
    const { bridge } = installMockSpeechBridge();

    render(createElement(LeoSpeakAction, { text: "你好世界" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "朗读" })).toBeTruthy();
    });
    expect(bridge.getSettings).toHaveBeenCalledTimes(1);
    expect(bridge.onSpeakState).toHaveBeenCalledTimes(1);
  });

  it("shares a single subscription across 3 instances and switches active state cleanly from A to B", async () => {
    const { bridge, emitSpeakState } = installMockSpeechBridge();

    render(
      createElement(
        "div",
        null,
        createElement(LeoSpeakAction, { text: "第一条回复" }),
        createElement(LeoSpeakAction, { text: "第二条回复" }),
        createElement(LeoSpeakAction, { text: "第三条回复" }),
      ),
    );

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "朗读" })).toHaveLength(3);
    });
    expect(bridge.getSettings).toHaveBeenCalledTimes(1);
    expect(bridge.onSpeakState).toHaveBeenCalledTimes(1);

    const buttons = screen.getAllByTestId("speak-action");
    fireEvent.click(buttons[0]!);
    act(() => emitSpeakState(true));

    await waitFor(() => {
      expect(screen.getAllByTestId("speak-action")[0]?.getAttribute("aria-pressed")).toBe("true");
      expect(screen.getAllByTestId("speak-action")[1]?.getAttribute("aria-pressed")).toBe("false");
    });

    // 切换到第二条朗读：先收到旧朗读的 speaking:false，再收到新朗读的 speaking:true；只有 B 保持激活态。
    fireEvent.click(screen.getAllByTestId("speak-action")[1]!);
    act(() => {
      emitSpeakState(false);
      emitSpeakState(true);
    });

    await waitFor(() => {
      const latest = screen.getAllByTestId("speak-action");
      expect(latest[0]?.getAttribute("aria-pressed")).toBe("false");
      expect(latest[1]?.getAttribute("aria-pressed")).toBe("true");
      expect(latest[2]?.getAttribute("aria-pressed")).toBe("false");
    });
    expect(bridge.getSettings).toHaveBeenCalledTimes(1);
    expect(bridge.onSpeakState).toHaveBeenCalledTimes(1);
  });
});
