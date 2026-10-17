// @vitest-environment jsdom

import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelSelectionView } from "@zcode/services";
import type { TimelineMarkerRow } from "@zcode/shared/zcode-protocol-v4";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

const modelSelectionMock = vi.hoisted(() => ({ view: null as ModelSelectionView | null }));

const context: ConversationRowRenderContext = {
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  sessionId: "session-1",
  theme: "system",
  workspacePath: "/workspace",
};

function currentContext(): ConversationRowRenderContext {
  return { ...context, modelSelectionView: modelSelectionMock.view };
}

function renderMarker(row: TimelineMarkerRow, locale: "en-US" | "zh-CN" = "zh-CN"): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(ConversationRowView, { context: currentContext(), row }),
    ),
  );
}

afterEach(() => {
  modelSelectionMock.view = null;
});

function replaceProviders(providers: readonly { providerId: string; label: string }[]): void {
  modelSelectionMock.view = {
    revision: 1,
    providers: providers.map((provider) => ({
      providerId: provider.providerId,
      providerName: provider.label,
      config: {},
      models: [],
    })),
  } satisfies ModelSelectionView;
}

describe("ConversationRowView timeline marker contract", () => {
  it("exposes compact type, status, and origin without using localized text as authority", () => {
    const html = renderMarker({
      rowId: 12,
      turnId: "turn-1",
      createdAt: 1_700_000_000_000,
      createdAtSeq: 1,
      kind: "timelineMarker",
      sourceCommandId: "command-compact-1",
      marker: {
        type: "compact",
        status: "success",
        origin: "manual",
        operationId: "compact-1",
      },
    });

    expect(html).toContain('data-row-kind="timelineMarker"');
    expect(html).toContain('data-marker-type="compact"');
    expect(html).toContain('data-status="success"');
    expect(html).toContain('data-origin="manual"');
    expect(html).toContain('data-source-command-id="command-compact-1"');
  });

  it("不同供应商的同名模型使用供应商名称展示完整切换身份", () => {
    replaceProviders([
      { providerId: "primary-provider", label: "Primary Coding Plan" },
      { providerId: "alternate-provider", label: "Alternate API" },
    ]);

    const html = renderMarker({
      rowId: 13,
      turnId: "turn-2",
      createdAt: 1_700_000_001_000,
      createdAtSeq: 2,
      kind: "timelineMarker",
      marker: {
        type: "modelChange",
        fromProvider: "primary-provider",
        fromModel: "glm-5.2",
        toProvider: "alternate-provider",
        toModel: "glm-5.2",
        toThought: "high",
      },
    });

    expect(html).toContain("模型已切换 Primary Coding Plan/glm-5.2 → Alternate API/glm-5.2");
    expect(html).toContain("lucide-arrow-right-left");
  });

  it("source 缺失的初始模型事实渲染为正在使用实际模型", () => {
    replaceProviders([{ providerId: "child-provider", label: "Child Provider" }]);

    const row: TimelineMarkerRow = {
      rowId: 17,
      turnId: "turn-child-1",
      createdAt: 1_700_000_005_000,
      createdAtSeq: 6,
      kind: "timelineMarker",
      marker: {
        type: "modelChange",
        toProvider: "child-provider",
        toModel: "child-model",
        toThought: "high",
      },
    };
    const html = renderMarker(row);
    const englishHtml = renderMarker(row, "en-US");

    expect(html).toContain("正在使用 Child Provider/child-model");
    expect(html).not.toContain("正在使用 Child Provider/child-model 模型");
    expect(html).not.toContain("模型已切换");
    expect(html).not.toContain("lucide-arrow-right-left");
    expect(englishHtml).toContain("Using Child Provider/child-model");
    expect(englishHtml).not.toContain("Using Child Provider/child-model model");
  });

  // [leo] Coding/Start/Team Plan label cases removed: Leo has no official Z.ai/BigModel plan accounts.

  it("供应商配置缺失时回落 provider ID 以保留同名模型身份", () => {
    const html = renderMarker({
      rowId: 14,
      turnId: "turn-3",
      createdAt: 1_700_000_002_000,
      createdAtSeq: 3,
      kind: "timelineMarker",
      marker: {
        type: "modelChange",
        fromProvider: "removed-provider",
        fromModel: "glm-5.2",
        toProvider: "current-provider",
        toModel: "glm-5.2",
        toThought: "high",
      },
    });

    expect(html).toContain("模型已切换 removed-provider/glm-5.2 → current-provider/glm-5.2");
  });

  it("供应商目录稍后水合时原地刷新已渲染 marker 名称", () => {
    const row: TimelineMarkerRow = {
      rowId: 15,
      turnId: "turn-4",
      createdAt: 1_700_000_003_000,
      createdAtSeq: 4,
      kind: "timelineMarker",
      marker: {
        type: "modelChange",
        fromProvider: "primary-provider",
        fromModel: "glm-5.2",
        toProvider: "alternate-provider",
        toModel: "glm-5.2",
        toThought: "high",
      },
    };
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationRowView, { context: currentContext(), row }),
      ),
    );
    expect(view.container.textContent).toContain(
      "模型已切换 primary-provider/glm-5.2 → alternate-provider/glm-5.2",
    );

    act(() => {
      replaceProviders([
        { providerId: "primary-provider", label: "Primary Coding Plan" },
        { providerId: "alternate-provider", label: "Alternate API" },
      ]);
      view.rerender(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, { context: currentContext(), row: { ...row } }),
        ),
      );
    });

    expect(view.container.textContent).toContain(
      "模型已切换 Primary Coding Plan/glm-5.2 → Alternate API/glm-5.2",
    );
    view.unmount();
  });
});
