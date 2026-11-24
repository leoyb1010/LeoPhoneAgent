import { describe, expect, it } from "vitest";
import type { ModelSelectionView } from "@zcode/services";
import { formatAcpModelId, parseAcpModelId } from "@zcode/shared/acp";
import { resolveLeoAgentKind } from "@/leo/leoAgentKind.js";
import {
  buildLeoAgentChoices,
  resolveLeoAgentChoice,
  isSameLeoAgentRoute,
  resolveLeoComposerAgentSelection,
} from "@/leo/leoAgentSelection.js";

const view = {
  revision: 1,
  providers: [
    {
      providerId: "api",
      providerName: "API",
      config: {},
      models: [{ modelId: "model-a", config: {} }],
    },
    {
      providerId: "acp",
      providerName: "Local agents",
      config: {},
      models: [{ modelId: "codex", config: {} }],
    },
  ],
} as unknown as ModelSelectionView;

describe("Leo local Agent selection", () => {
  it("keeps a custom model on the selected CLI route, even with a provider-qualified ID", () => {
    const model = formatAcpModelId("codex", "router/custom-model:beta");
    const custom = { provider: "acp", model };
    expect(parseAcpModelId(model)).toEqual({ agentId: "codex", customModelId: "router/custom-model:beta" });
    expect(resolveLeoAgentKind(custom)).toBe("codex");
    expect(resolveLeoAgentChoice("codex", view, custom)).toEqual(custom);
    expect(isSameLeoAgentRoute({ provider: "acp", model: "codex" }, custom)).toBe(true);
    expect(isSameLeoAgentRoute({ provider: "acp", model: "claude-code" }, custom)).toBe(false);
    expect(resolveLeoComposerAgentSelection(false, custom, { provider: "acp", model: "codex" })).toEqual(custom);
    expect(parseAcpModelId("codex@bad%20model")).toBeNull();
  });
  it("shows the draft Agent instead of a stale prewarm snapshot, and pins an existing task's actual Agent", () => {
    expect(
      resolveLeoComposerAgentSelection(false, { provider: "api", model: "one" }, null),
    ).toEqual({ provider: "", model: "" });
    expect(
      resolveLeoComposerAgentSelection(
        true,
        { provider: "acp", model: "codex" },
        { provider: "api", model: "base" },
      ),
    ).toEqual({ provider: "acp", model: "codex" });
    expect(
      resolveLeoComposerAgentSelection(
        false,
        { provider: "acp", model: "claude-code" },
        { provider: "acp", model: "codex" },
      ),
    ).toEqual({ provider: "acp", model: "codex" });
  });
  it("pins the execution engine while allowing API model changes inside ZCode", () => {
    expect(
      isSameLeoAgentRoute(
        { provider: "api", model: "one" },
        { provider: "other-api", model: "two" },
      ),
    ).toBe(true);
    expect(
      isSameLeoAgentRoute(
        { provider: "acp", model: "codex" },
        { provider: "acp", model: "claude-code" },
      ),
    ).toBe(false);
    expect(
      isSameLeoAgentRoute({ provider: "api", model: "one" }, { provider: "acp", model: "codex" }),
    ).toBe(false);
  });
  it("shows the requested local agents without pretending an absent CLI is available", () => {
    const choices = buildLeoAgentChoices(view, { provider: "api", model: "model-a" });
    expect(choices.map((item) => [item.id, item.available])).toEqual([
      ["leobot", true],
      ["codex", true],
      ["claude-code", false],
    ]);
  });
  it("selects the actual ACP route, and restores a valid default model when returning to ZCode", () => {
    expect(resolveLeoAgentChoice("codex", view, { provider: "api", model: "model-a" })).toEqual({
      provider: "acp",
      model: "codex",
    });
    expect(resolveLeoAgentChoice("leobot", view, { provider: "acp", model: "codex" })).toEqual({
      provider: "api",
      model: "model-a",
    });
  });
  it("does not manufacture a model or silently substitute an unavailable agent", () => {
    expect(resolveLeoAgentChoice("claude-code", view, null)).toBeNull();
    expect(
      resolveLeoAgentChoice("leobot", { ...view, providers: view.providers.slice(1) }, null),
    ).toBeNull();
    expect(buildLeoAgentChoices(null, null).every((item) => !item.available)).toBe(true);
  });
  it("keeps a valid current ZCode model instead of changing it when ZCode is selected again", () => {
    expect(resolveLeoAgentChoice("leobot", view, { provider: "api", model: "model-a" })).toEqual({
      provider: "api",
      model: "model-a",
    });
  });
});
