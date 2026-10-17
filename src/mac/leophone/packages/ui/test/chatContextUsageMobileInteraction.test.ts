// @vitest-environment jsdom
import { createContext, createElement, useContext, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatContextUsage } from "@/chat-input-toolbar/contextUsage.js";

const contextOpenContext = createContext(false);

vi.mock("@/components/ai-elements/context.js", () => ({
  Context: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    createElement(contextOpenContext.Provider, { value: Boolean(open) }, children),
  ContextContent: ({ children }: { children?: ReactNode }) =>
    useContext(contextOpenContext) ? createElement("div", null, children) : null,
  ContextContentBody: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("div", props, children),
  ContextTrigger: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("button", props, children ?? "context"),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    locale: "en-US",
  }),
}));

function renderContextUsage() {
  return render(
    createElement(ChatContextUsage, {
      intl: {
        formatMessage: ({ id }: { id: string }) => id,
      } as never,
      locale: "en-US",
      selectedProvider: "glm",
      taskUsage: {
        used: 17_000,
        size: 1_000_000,
      },
    }),
  );
}

describe("ChatContextUsage mobile interaction", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens the context panel from a touch pointer on a device without hover", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(hover: none)",
      media: query,
    }));

    renderContextUsage();

    const trigger = screen.getByRole("button", { name: "chat.contextUsage" });
    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.touchStart(trigger);
    fireEvent.pointerUp(trigger, { pointerType: "touch" });

    expect(screen.getByText("chat.contextUsage.title")).toBeTruthy();
  });

  // [leo] Start Plan 余额入口随官方套餐一并删除，对应的触摸刷新用例移除。

  it("keeps a desktop pointer from changing the hover card contract", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
    }));

    renderContextUsage();

    fireEvent.pointerDown(screen.getByRole("button", { name: "chat.contextUsage" }), {
      pointerType: "mouse",
    });

    expect(screen.queryByText("chat.contextUsage.title")).toBeNull();
  });
});
