import assert from "node:assert/strict";
import test from "node:test";

import { OPENCODE_GO_MODELS } from "@earendil-works/pi-ai/providers/opencode-go.models";

import {
  documentedApi,
  openCodeSessionHeaders,
  providerModels,
  setOpenCodeGoIdsForTest,
  synthesizeOpenCodeGoModel,
} from "./openCodeGoModels.js";

const builtins = Object.values(OPENCODE_GO_MODELS) as never[];
const runtime = { getModels: (providerId: string) => (providerId === "opencode-go" ? builtins : []) } as never;

test("the official live list wins: every model it names is offered, including ones pi hasn't shipped yet", async () => {
  const live = ["kimi-k3", "grok-4.7", "gpt-6-luna", "mimo-v2.6-pro", "space-bunny-free"];
  setOpenCodeGoIdsForTest(live);
  const models = (await providerModels(runtime, "opencode-go")) as unknown as Array<{ id: string; api: string; baseUrl: string }>;
  assert.deepEqual(
    models.map((model) => model.id),
    live,
  );
  const byId = new Map(models.map((model) => [model.id, model]));
  // 新模型跟同系列走:grok-4.7 照 grok-4.6、gpt-6-luna 照 gpt-5.6-luna 走 Responses,mimo 走 Chat Completions。
  assert.equal(byId.get("grok-4.7")?.api, "openai-responses");
  assert.equal(byId.get("gpt-6-luna")?.api, "openai-responses");
  assert.equal(byId.get("mimo-v2.6-pro")?.api, "openai-completions");
  assert.equal(byId.get("mimo-v2.6-pro")?.baseUrl, "https://opencode.ai/zen/go/v1");
  // 没有同系列的按文档端点表,配成最朴素的(不带别家模型的兼容参数)。
  const bunny = byId.get("space-bunny-free") as unknown as { api: string; compat?: unknown };
  assert.equal(bunny.api, "openai-completions");
  assert.equal(bunny.compat, undefined);
});

test("without the live list (offline) the provider falls back to pi's built-in table", async () => {
  setOpenCodeGoIdsForTest(null, async () => {
    throw new Error("offline");
  });
  const models = await providerModels(runtime, "opencode-go");
  assert.equal(models.length, builtins.length);
});

test("other providers are untouched", async () => {
  setOpenCodeGoIdsForTest(["kimi-k3"]);
  assert.equal((await providerModels(runtime, "openai-codex")).length, 0);
});

test("documented endpoint table", () => {
  assert.equal(documentedApi("gpt-6-luna"), "openai-responses");
  assert.equal(documentedApi("grok-4.7"), "openai-responses");
  assert.equal(documentedApi("muse-spark-1.3-contributor"), "openai-responses");
  assert.equal(documentedApi("minimax-m2.5"), "anthropic-messages");
  assert.equal(documentedApi("qwen3.5-plus"), "anthropic-messages");
  assert.equal(documentedApi("glm-5"), "openai-completions");
  assert.equal(synthesizeOpenCodeGoModel("unknown-x1", []), null);
});

test("retired models the live list still names are never offered", async () => {
  setOpenCodeGoIdsForTest(["glm-5", "glm-5.3", "kimi-k2.5", "hy3-preview", "deepseek-flash"]);
  const ids = (await providerModels(runtime, "opencode-go")).map((model) => model.id);
  assert.deepEqual(ids, ["glm-5.3", "deepseek-flash"]);
});

test("OpenCode requests get a session id (Go rejects them without one); other providers are untouched", () => {
  const go = { provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" };
  assert.deepEqual(openCodeSessionHeaders(go, { "x-session-id": "abc-123" }), {
    "x-opencode-session": "abc-123",
  });
  assert.match(openCodeSessionHeaders(go, {})?.["x-opencode-session"] ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(
    openCodeSessionHeaders(
      { provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" },
      { "x-session-id": "abc" },
    ),
    undefined,
  );
});

test("MiniMax and Qwen go over Anthropic Messages as the docs say, even where pi's table says Chat Completions", async () => {
  setOpenCodeGoIdsForTest(["minimax-m2.7", "qwen3.8-max", "minimax-m3", "glm-5.3"]);
  const byId = new Map(
    ((await providerModels(runtime, "opencode-go")) as unknown as Array<Record<string, unknown>>).map(
      (model) => [model.id, model],
    ),
  );
  for (const id of ["minimax-m2.7", "qwen3.8-max", "minimax-m3"]) {
    assert.equal(byId.get(id)?.api, "anthropic-messages", id);
    assert.equal(byId.get(id)?.baseUrl, "https://opencode.ai/zen/go", id);
    assert.equal(byId.get(id)?.compat, undefined, id);
  }
  assert.equal(byId.get("glm-5.3")?.api, "openai-completions");
});
