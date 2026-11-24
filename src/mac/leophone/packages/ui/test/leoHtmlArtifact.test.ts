// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  create: vi.fn(async (_input: unknown) => ({ id: "preview-1", url: "leo-html://preview-1/" })),
  release: vi.fn(async (_id: string) => {}),
  save: vi.fn(async (_input: unknown) => ({ success: true })),
  insert: vi.fn(),
}));
const previewPort = { create: mocks.create, release: mocks.release };
vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => ({ htmlPreview: previewPort, saveFile: mocks.save }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({ useZCodeIntl: () => ({ locale: "zh-CN" }) }));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: { getState: () => ({ requestComposerTextInsert: mocks.insert }) },
}));
import { LeoArtifactActions } from "@/leo/LeoArtifactActions.js";
import { LeoHtmlPreview } from "@/leo/LeoHtmlPreview.js";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = "";
  vi.clearAllMocks();
});
function props(content = "<h1>你好</h1><script>run()</script>") {
  return {
    content,
    title: "报告",
    sourcePath: "/workspace/报告.html",
    sourceView: createElement("pre", null, content),
    workspacePath: "/workspace",
    workspaceIdentity: "same-path-isolated",
    targetSessionId: "task-a",
  };
}
async function mount(input = props()) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(LeoHtmlPreview, input)));
}
async function click(id: string) {
  await act(async () =>
    (document.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).click(),
  );
}

describe("HTML artifact controls", () => {
  it("defaults to static; script consent is revoked when the file content changes", async () => {
    await mount();
    expect(mocks.create).toHaveBeenLastCalledWith({ html: props().content, interactive: false });
    expect(document.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
    await click("leo-html-run");
    expect(mocks.create).toHaveBeenLastCalledWith({ html: props().content, interactive: true });
    await act(async () => root!.render(createElement(LeoHtmlPreview, props("<h1>新版本</h1>"))));
    expect(mocks.create).toHaveBeenLastCalledWith({ html: "<h1>新版本</h1>", interactive: false });
    await act(async () => root!.render(createElement(LeoHtmlPreview, props())));
    expect(mocks.create).toHaveBeenLastCalledWith({ html: props().content, interactive: false });
    expect(mocks.release).toHaveBeenCalled();
  });
  it("downloads original bytes, and refines through the owning workspace draft without replacement", async () => {
    await mount();
    await click("leo-html-source-tab");
    expect(document.querySelector("pre")?.textContent).toBe(props().content);
    await click("leo-html-download");
    const request = mocks.save.mock.calls[0]![0] as { data: ArrayBuffer; suggestedName: string };
    expect(new TextDecoder().decode(request.data)).toBe(props().content);
    expect(request.suggestedName).toBe("报告.html");
    await click("leo-html-refine");
    expect(mocks.insert).toHaveBeenCalledWith(
      "/workspace",
      expect.stringContaining("/workspace/报告.html"),
      "same-path-isolated",
      undefined,
      "append-if-missing",
      "task-a",
    );
  });
});

it("does not offer a falsely successful refinement when no task/draft target is known", async () => {
  await mount({ ...props(), targetSessionId: undefined });
  expect(document.querySelector('[data-testid="leo-html-refine"]')).toBeNull();
});

it("recreates its bounded native preview after a source/preview round-trip", async () => {
  await mount();
  const initial = mocks.create.mock.calls.length;
  await click("leo-html-source-tab");
  expect(mocks.release).toHaveBeenCalled();
  await click("leo-html-preview-tab");
  expect(mocks.create.mock.calls.length).toBe(initial + 1);
});

it("downloads Markdown text with its original name and targets only its source task for edits", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const input = { ...props("# 报告\r\n"), format: "Markdown" as const, sourcePath: "/workspace/报告.md" };
  await act(async () => root!.render(createElement(LeoArtifactActions, input)));
  await click("leo-markdown-download");
  const request = mocks.save.mock.calls[0]![0] as { data: ArrayBuffer; suggestedName: string };
  expect(new TextDecoder().decode(request.data)).toBe(input.content);
  expect(request.suggestedName).toBe("报告.md");
  await click("leo-markdown-refine");
  expect(mocks.insert).toHaveBeenCalledWith("/workspace", expect.stringContaining(input.sourcePath),
    "same-path-isolated", undefined, "append-if-missing", "task-a");
});
