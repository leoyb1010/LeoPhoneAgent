// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { ComposerRunSettingsPicker } from "./ComposerRunSettingsPicker";
const agent = { id: "a", companyId: "c", name: "Leo", adapterType: "opencode_local", adapterConfig: {} } as Agent;
const catalog = [{ id: "opencode-go/Model-A", label: "Model Alpha" }, { id: "opencode-go/Model-B", label: "opencode-go/Model-B" }];
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let client: QueryClient;
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
async function render(query = "") {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const change = vi.fn();
  await act(async () => root.render(<QueryClientProvider client={client}><ComposerRunSettingsPicker companyId="c" assigneeValue="agent:a" currentAssigneeValue="agent:a" agents={new Map([["a", agent]])} options={[{id:"agent:a",label:"Leo"}]} settings={null} onAssigneeChange={vi.fn()} onSettingsChange={change} modelOptionsOverride={catalog} initialOpen initialView="models" initialModelSearch={query} mobile /></QueryClientProvider>));
  return change;
}
async function key(target: Element, value: string) { await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", {key:value,bubbles:true,cancelable:true})); }); }
afterEach(async () => { if (root) await act(async () => root.unmount()); host?.remove(); client?.clear(); });
it("Enter chooses the canonical catalog ID for an exact case-insensitive search", async () => {
  const change = await render("OPENCODE-GO/model-a");
  await key(document.querySelector('input[type="search"]')!, "Enter");
  expect(change).toHaveBeenCalledWith({ model:"opencode-go/Model-A",effort:null,fast:false });
});
it("Arrow keys enter and cycle the model list without losing focus", async () => {
  const change = await render(); const input = document.querySelector('input[type="search"]')!;
  await key(input,"ArrowUp");
  const options = [...document.querySelectorAll<HTMLButtonElement>('[role="listbox"] button[role="option"]')];
  expect(document.activeElement).toBe(options.at(-1));
  await key(document.activeElement!,"ArrowDown"); expect(document.activeElement).toBe(options[0]);
  await key(document.activeElement!,"ArrowDown"); expect(document.activeElement).toBe(options[1]);
  await act(async () => options[1]!.click());
  expect(change).toHaveBeenCalledWith({ model:"opencode-go/Model-A",effort:null,fast:false });
});
it("keeps explicit custom provider/model IDs available", async () => {
  const change = await render("custom/provider-model");
  await key(document.querySelector('input[type="search"]')!,"Enter");
  expect(change).toHaveBeenCalledWith({model:"custom/provider-model",effort:null,fast:false});
});
it("does not render the same model ID twice in one choice", async () => {
  await render("opencode-go/Model-B");
  const item = document.querySelector('[role="listbox"] button[role="option"]')!;
  expect(item.textContent?.split("opencode-go/Model-B").length).toBe(2);
});
