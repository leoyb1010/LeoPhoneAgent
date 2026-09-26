// [leo] prompt_cache_key 注入与 openai-compatible 缓存命中字段回退。

import assert from "node:assert/strict";
import test from "node:test";

import {
  convertLeoOpenAICompatibleUsage,
  createLeoPromptCacheKeyFetch,
  leoPromptCacheKeyForSession,
  resolveLeoPromptCacheKeyMode,
  shouldSendLeoPromptCacheKey,
} from "../../src/model/leo-prompt-cache.js";

function recordingFetch() {
  const bodies: unknown[] = [];
  const fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const text = typeof init?.body === "string" ? init.body : request instanceof Request ? await request.text() : "";
    bodies.push(text ? JSON.parse(text) : undefined);
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  return { bodies, fetch };
}

test("mode comes from ZCODE_LEO_AGENT.promptCacheKey; auto only trusts OpenAI and OpenRouter hosts", () => {
  assert.equal(resolveLeoPromptCacheKeyMode({}), "auto");
  assert.equal(resolveLeoPromptCacheKeyMode({ ZCODE_LEO_AGENT: '{"promptCacheKey":true}' }), "on");
  assert.equal(resolveLeoPromptCacheKeyMode({ ZCODE_LEO_AGENT: '{"promptCacheKey":false}' }), "off");
  assert.equal(resolveLeoPromptCacheKeyMode({ ZCODE_LEO_AGENT: "{broken" }), "auto");

  assert.equal(shouldSendLeoPromptCacheKey("auto", "https://api.openai.com/v1"), true);
  assert.equal(shouldSendLeoPromptCacheKey("auto", "https://openrouter.ai/api/v1"), true);
  assert.equal(shouldSendLeoPromptCacheKey("auto", "https://api.deepseek.com/v1"), false);
  assert.equal(shouldSendLeoPromptCacheKey("auto", undefined), false);
  assert.equal(shouldSendLeoPromptCacheKey("on", "http://127.0.0.1:8000/v1"), true);
  assert.equal(shouldSendLeoPromptCacheKey("off", "https://api.openai.com/v1"), false);
});

test("the key is stable per session, differs across sessions and never contains the raw id", () => {
  const key = leoPromptCacheKeyForSession("abc123");
  assert.equal(key, leoPromptCacheKeyForSession("abc123"));
  assert.notEqual(key, leoPromptCacheKeyForSession("abc124"));
  assert.match(key, /^leo-[0-9a-f]{32}$/u);
  assert.ok(!key.includes("abc123"));
});

test("fetch wrapper adds prompt_cache_key from x-session-id, keeps existing keys and non-chat bodies", async () => {
  const { bodies, fetch } = recordingFetch();
  const wrapped = createLeoPromptCacheKeyFetch({ fetch, enabled: true });
  const headers = { "x-session-id": "s-1", "content-type": "application/json" };

  await wrapped("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "gpt-5", messages: [] }),
  });
  await wrapped(
    new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5", input: [] }),
    }),
  );
  await wrapped("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "gpt-5", messages: [], prompt_cache_key: "mine" }),
  });
  await wrapped("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "e", data: "x" }),
  });
  await wrapped("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5", messages: [] }),
  });

  const expected = leoPromptCacheKeyForSession("s-1");
  assert.equal((bodies[0] as Record<string, unknown>).prompt_cache_key, expected);
  assert.equal((bodies[1] as Record<string, unknown>).prompt_cache_key, expected);
  assert.equal((bodies[2] as Record<string, unknown>).prompt_cache_key, "mine");
  assert.equal((bodies[3] as Record<string, unknown>).prompt_cache_key, undefined);
  assert.equal((bodies[4] as Record<string, unknown>).prompt_cache_key, undefined);

  const disabled = createLeoPromptCacheKeyFetch({ fetch, enabled: false });
  assert.equal(disabled, fetch);
});

test("openai-compatible usage: standard, DeepSeek and Kimi cache-hit fields all land in cacheRead", () => {
  const standard = convertLeoOpenAICompatibleUsage({
    prompt_tokens: 1000,
    completion_tokens: 50,
    prompt_tokens_details: { cached_tokens: 800 },
    completion_tokens_details: { reasoning_tokens: 10 },
  });
  assert.equal(standard.inputTokens.cacheRead, 800);
  assert.equal(standard.inputTokens.noCache, 200);
  assert.equal(standard.outputTokens.text, 40);

  const deepseek = convertLeoOpenAICompatibleUsage({
    prompt_tokens: 1000,
    completion_tokens: 5,
    prompt_cache_hit_tokens: 640,
    prompt_cache_miss_tokens: 360,
  } as never);
  assert.equal(deepseek.inputTokens.cacheRead, 640);

  const kimi = convertLeoOpenAICompatibleUsage({ prompt_tokens: 900, completion_tokens: 5, cached_tokens: 512 } as never);
  assert.equal(kimi.inputTokens.cacheRead, 512);

  const none = convertLeoOpenAICompatibleUsage({ prompt_tokens: 10, completion_tokens: 1 });
  assert.equal(none.inputTokens.cacheRead, 0);
  assert.equal(convertLeoOpenAICompatibleUsage(null).inputTokens.total, undefined);
});

test("end to end through the AI SDK: body carries prompt_cache_key and DeepSeek hits reach cachedInputTokens", async () => {
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  const { generateText } = await import("ai");
  let sentBody: Record<string, unknown> | undefined;
  const upstream = (async (_request: RequestInfo | URL, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        id: "c1",
        object: "chat.completion",
        created: 1,
        model: "m",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1200, completion_tokens: 3, total_tokens: 1203, prompt_cache_hit_tokens: 1024 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  const provider = createOpenAICompatible({
    name: "evalep",
    baseURL: "http://127.0.0.1:9/v1",
    apiKey: "dummy",
    fetch: createLeoPromptCacheKeyFetch({ fetch: upstream, enabled: true }),
    convertUsage: convertLeoOpenAICompatibleUsage,
  });
  const result = await generateText({
    model: provider("m"),
    prompt: "hi",
    headers: { "x-session-id": "session-42" },
  });
  assert.equal(sentBody?.prompt_cache_key, leoPromptCacheKeyForSession("session-42"));
  assert.equal(result.usage.inputTokenDetails?.cacheReadTokens ?? result.usage.cachedInputTokens, 1024);
});
