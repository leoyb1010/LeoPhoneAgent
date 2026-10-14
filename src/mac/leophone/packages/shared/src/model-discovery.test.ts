import assert from "node:assert/strict";
import test from "node:test";
import {
  diffDiscoveredModels,
  isKeylessLocalBaseUrl,
  isLikelyNonChatModel,
  modelDiscoveryRequestSchema,
  modelDiscoveryResultSchema,
  prettifyModelId,
  resolveModelFamily,
  selectDefaultDiscoveredModels,
  type DiscoveredModel,
} from "./model-discovery.js";

test("prettifyModelId turns vendor ids into readable names", () => {
  assert.equal(prettifyModelId("claude-opus-5-5"), "Claude Opus 5.5");
  assert.equal(prettifyModelId("claude-haiku-4-5-20251001"), "Claude Haiku 4.5");
  assert.equal(prettifyModelId("claude-3-5-sonnet-20241022"), "Claude 3.5 Sonnet");
  assert.equal(prettifyModelId("gpt-5.5"), "GPT-5.5");
  assert.equal(prettifyModelId("gpt-4o-mini"), "GPT-4o Mini");
  assert.equal(prettifyModelId("gpt-4o-2024-08-06"), "GPT-4o");
  assert.equal(prettifyModelId("o3-mini"), "o3 Mini");
  assert.equal(prettifyModelId("gemini-2.5-pro"), "Gemini 2.5 Pro");
  assert.equal(prettifyModelId("deepseek-chat"), "DeepSeek Chat");
  assert.equal(prettifyModelId("qwen3-coder-480b-a35b"), "Qwen3 Coder 480B A35B");
  assert.equal(prettifyModelId("anthropic/claude-sonnet-4-5"), "Claude Sonnet 4.5");
});

test("prettifyModelId keeps vendor-cased and unknown ids readable", () => {
  assert.equal(prettifyModelId("GLM-5.3"), "GLM-5.3");
  assert.equal(prettifyModelId("DeepSeek-V3"), "DeepSeek-V3");
  assert.equal(prettifyModelId("my-custom-model"), "My Custom Model");
  assert.equal(prettifyModelId("x"), "X");
});

test("resolveModelFamily groups by vendor family", () => {
  assert.equal(resolveModelFamily("claude-opus-5-5"), "claude-opus");
  assert.equal(resolveModelFamily("claude-3-5-sonnet-20241022"), "claude-sonnet");
  assert.equal(resolveModelFamily("gpt-5.5"), "gpt");
  assert.equal(resolveModelFamily("o4-mini"), "openai-o");
  assert.equal(resolveModelFamily("openai/gpt-4o"), "gpt");
  assert.equal(resolveModelFamily("gemini-2.5-flash"), "gemini");
  assert.equal(resolveModelFamily("deepseek-reasoner"), "deepseek");
});

test("isLikelyNonChatModel flags embedding, audio, image and moderation models", () => {
  for (const id of [
    "text-embedding-3-large",
    "tts-1",
    "whisper-1",
    "gpt-4o-transcribe",
    "dall-e-3",
    "gpt-image-1",
    "omni-moderation-latest",
    "gemini-embedding-001",
  ]) {
    assert.equal(isLikelyNonChatModel(id), true, id);
  }
  for (const id of ["gpt-5.5", "claude-opus-5-5", "deepseek-chat", "gemini-2.5-pro", "o3"]) {
    assert.equal(isLikelyNonChatModel(id), false, id);
  }
});

function model(id: string, extra: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return { id, displayName: prettifyModelId(id), ...extra };
}

test("selectDefaultDiscoveredModels picks the newest few per family and skips existing", () => {
  const models = [
    model("claude-opus-4-1"),
    model("claude-opus-5-5"),
    model("claude-opus-5"),
    model("claude-haiku-4-5-20251001"),
    model("claude-haiku-4-5"),
    model("gpt-5.5"),
    model("gpt-5"),
    model("gpt-4o"),
    model("text-embedding-3-small", { hidden: true }),
  ];
  const picked = selectDefaultDiscoveredModels(models, new Set(["gpt-5.5"]));
  assert.deepEqual(
    new Set(picked),
    new Set(["claude-opus-5-5", "claude-opus-5", "claude-haiku-4-5", "gpt-5", "gpt-4o"]),
  );
});

test("selectDefaultDiscoveredModels prefers catalog release dates", () => {
  const picked = selectDefaultDiscoveredModels(
    [
      model("model-a", { releaseDate: "2024-01-01" }),
      model("model-b", { releaseDate: "2026-01-01" }),
      model("model-c", { releaseDate: "2025-01-01" }),
    ],
    new Set(),
    { perFamily: 1 },
  );
  assert.deepEqual(picked, ["model-b"]);
});

test("diffDiscoveredModels reports added and removed ids", () => {
  assert.deepEqual(diffDiscoveredModels([model("a"), model("b")], ["b", "c"]), {
    added: ["a"],
    removed: ["c"],
  });
});

test("isKeylessLocalBaseUrl only accepts loopback and .local hosts", () => {
  assert.equal(isKeylessLocalBaseUrl("http://localhost:11434/v1"), true);
  assert.equal(isKeylessLocalBaseUrl("http://127.0.0.1:1234/v1"), true);
  assert.equal(isKeylessLocalBaseUrl("http://[::1]:8080"), true);
  assert.equal(isKeylessLocalBaseUrl("http://my-mac.local:11434"), true);
  assert.equal(isKeylessLocalBaseUrl("https://api.openai.com/v1"), false);
  assert.equal(isKeylessLocalBaseUrl("not a url"), false);
  assert.equal(isKeylessLocalBaseUrl(""), false);
});

test("request/result schemas validate the RPC boundary", () => {
  assert.ok(modelDiscoveryRequestSchema.safeParse({ providerId: "p1" }).success);
  assert.ok(
    modelDiscoveryRequestSchema.safeParse({
      baseUrl: "http://localhost:11434/v1",
      apiFormat: "openai-chat-completions",
    }).success,
  );
  assert.equal(modelDiscoveryRequestSchema.safeParse({ providerId: "" }).success, false);
  assert.equal(
    modelDiscoveryRequestSchema.safeParse({ baseUrl: "x", apiFormat: "gemini" }).success,
    false,
  );
  assert.ok(
    modelDiscoveryResultSchema.safeParse({
      models: [{ id: "gpt-5.5", displayName: "GPT-5.5", capabilities: { vision: true } }],
      source: "endpoint",
    }).success,
  );
});
