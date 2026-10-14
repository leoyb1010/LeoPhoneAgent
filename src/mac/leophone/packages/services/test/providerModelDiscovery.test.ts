import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  discoverProviderModels,
  normalizeAnthropicBaseUrl,
  parseModelListBody,
} from "../src/model-provider/providerModelDiscovery.js";
import {
  buildModelsDevCatalog,
  createModelsDevCatalogSource,
  type ModelsDevCatalogSource,
} from "../src/model-provider/modelsDevCatalog.js";
import { resolveModelDiscoveryTarget } from "../src/model-provider/providerFacadeServices.js";

interface Recorded {
  readonly url: string;
  readonly headers: Record<string, string>;
}

type Route = (url: string) => Response | Error;

/** 假 transport:按 URL 回固定响应,记录每次请求的 URL 和头,不访问真实网络。 */
function fakeFetch(route: Route) {
  const calls: Recorded[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    calls.push({ url, headers });
    const result = route(url);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function html(status = 200): Response {
  return new Response("<!doctype html><html><body>gateway</body></html>", {
    status,
    headers: { "content-type": "text/html" },
  });
}

const catalogData = {
  anthropic: {
    id: "anthropic",
    models: {
      "claude-opus-5-5": {
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        reasoning: true,
        tool_call: true,
        release_date: "2026-08-01",
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 400000, output: 64000 },
      },
    },
  },
  "some-relay": {
    id: "some-relay",
    api: "https://relay.example.com/v1",
    models: {
      "relay-model-1": { id: "relay-model-1", name: "Relay Model One" },
    },
  },
};

const staticCatalog: ModelsDevCatalogSource = {
  load: async () => buildModelsDevCatalog(catalogData),
};

test("OpenAI format lists /models with Bearer and enriches names", async () => {
  const { fetch, calls } = fakeFetch(() =>
    json({ data: [{ id: "gpt-5.5" }, { id: "text-embedding-3-small" }, { id: "gpt-5.5" }] }),
  );
  const result = await discoverProviderModels(
    {
      baseUrl: "https://relay.example.com/v1/",
      apiFormat: "openai-chat-completions",
      apiKey: "sk-test",
    },
    { fetch },
  );
  assert.equal(result.source, "endpoint");
  assert.equal(result.error, undefined);
  assert.equal(calls[0]!.url, "https://relay.example.com/v1/models");
  assert.equal(calls[0]!.headers.authorization, "Bearer sk-test");
  assert.deepEqual(
    result.models.map((model) => [model.id, model.displayName, model.hidden ?? false]),
    [
      ["gpt-5.5", "GPT-5.5", false],
      ["text-embedding-3-small", "Text Embedding 3 Small", true],
    ],
  );
});

test("keyless local endpoints send no auth header", async () => {
  const { fetch, calls } = fakeFetch(() => json({ object: "list", data: [{ id: "llama3.1:8b" }] }));
  const result = await discoverProviderModels(
    { baseUrl: "http://localhost:11434/v1", apiFormat: "openai-chat-completions" },
    { fetch },
  );
  assert.equal(result.models[0]!.id, "llama3.1:8b");
  assert.equal(calls[0]!.headers.authorization, undefined);
});

test("OpenAI base without /v1 retries /v1/models after 404", async () => {
  const { fetch, calls } = fakeFetch((url) =>
    url.endsWith("/v1/models") ? json({ data: [{ id: "deepseek-chat" }] }) : json({}, 404),
  );
  const result = await discoverProviderModels(
    { baseUrl: "https://api.example.com", apiFormat: "openai-chat-completions", apiKey: "k" },
    { fetch },
  );
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://api.example.com/models", "https://api.example.com/v1/models"],
  );
  assert.equal(result.source, "endpoint");
  assert.equal(result.models[0]!.displayName, "DeepSeek Chat");
});

test("Anthropic format pages with has_more/last_id and sends gateway headers", async () => {
  const { fetch, calls } = fakeFetch((url) =>
    url.includes("after_id=")
      ? json({ data: [{ id: "claude-haiku-4-5" }], has_more: false })
      : json({
          data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }],
          has_more: true,
          last_id: "claude-opus-5-5",
        }),
  );
  const result = await discoverProviderModels(
    {
      baseUrl: "https://gateway.example.com/anthropic",
      apiFormat: "anthropic-messages",
      apiKey: "ak",
    },
    { fetch, catalog: staticCatalog },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "https://gateway.example.com/anthropic/v1/models?limit=1000");
  assert.match(calls[1]!.url, /after_id=claude-opus-5-5/u);
  assert.equal(calls[0]!.headers["x-api-key"], "ak");
  assert.equal(calls[0]!.headers["anthropic-version"], "2023-06-01");
  assert.equal(calls[0]!.headers.authorization, "Bearer ak");
  assert.deepEqual(
    result.models.map((model) => model.id),
    ["claude-opus-5-5", "claude-haiku-4-5"],
  );
  const opus = result.models[0]!;
  assert.equal(opus.contextWindow, 400000);
  assert.equal(opus.maxOutput, 64000);
  assert.deepEqual(opus.capabilities, { vision: true, tools: true, reasoning: true });
});

test("official Anthropic host does not get a duplicate Bearer header", async () => {
  const { fetch, calls } = fakeFetch(() => json({ data: [{ id: "claude-opus-5-5" }] }));
  await discoverProviderModels(
    { baseUrl: "https://api.anthropic.com", apiFormat: "anthropic-messages", apiKey: "ak" },
    { fetch },
  );
  assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(calls[0]!.headers.authorization, undefined);
});

test("Anthropic-compatible gateway without list endpoint falls back to origin /v1/models", async () => {
  const { fetch, calls } = fakeFetch((url) =>
    url === "https://open.example.com/v1/models" ? json({ data: [{ id: "kimi-k2" }] }) : html(404),
  );
  const result = await discoverProviderModels(
    {
      baseUrl: "https://open.example.com/api/anthropic",
      apiFormat: "anthropic-messages",
      apiKey: "k",
    },
    { fetch },
  );
  assert.equal(calls.at(-1)!.url, "https://open.example.com/v1/models");
  assert.equal(calls.at(-1)!.headers.authorization, "Bearer k");
  assert.equal(result.source, "endpoint");
  assert.deepEqual(
    result.models.map((model) => model.id),
    ["kimi-k2"],
  );
});

test("401 reports auth and never falls back to the builtin list", async () => {
  const { fetch, calls } = fakeFetch(() => json({ error: "bad key" }, 401));
  const result = await discoverProviderModels(
    {
      baseUrl: "https://relay.example.com",
      apiFormat: "openai-chat-completions",
      apiKey: "wrong",
      builtinModelIds: ["gpt-5.5"],
    },
    { fetch },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(result.models, []);
  assert.equal(result.error?.kind, "auth");
});

test("HTML or invalid JSON falls back to builtin models with not_supported", async () => {
  const { fetch } = fakeFetch(() => html(200));
  const result = await discoverProviderModels(
    {
      baseUrl: "https://relay.example.com/v1",
      apiFormat: "openai-chat-completions",
      builtinModelIds: ["claude-opus-5-5", "gpt-5.5"],
    },
    { fetch },
  );
  assert.equal(result.source, "builtin");
  assert.equal(result.error?.kind, "not_supported");
  assert.deepEqual(
    result.models.map((model) => model.displayName),
    ["Claude Opus 5.5", "GPT-5.5"],
  );
});

test("404 without builtin list falls back to models.dev by base URL", async () => {
  const { fetch } = fakeFetch(() => new Response("not json", { status: 200 }));
  const result = await discoverProviderModels(
    { baseUrl: "https://relay.example.com/v1", apiFormat: "openai-chat-completions" },
    { fetch, catalog: staticCatalog },
  );
  assert.equal(result.source, "catalog");
  assert.equal(result.error?.kind, "not_supported");
  assert.deepEqual(
    result.models.map((model) => model.displayName),
    ["Relay Model One"],
  );
});

test("network and TLS failures are reported with their kind", async () => {
  const refused = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
      code: "ECONNREFUSED",
    }),
  });
  const network = await discoverProviderModels(
    { baseUrl: "http://127.0.0.1:11434/v1", apiFormat: "openai-chat-completions" },
    { fetch: fakeFetch(() => refused).fetch },
  );
  assert.equal(network.error?.kind, "network");
  assert.match(network.error!.message, /ECONNREFUSED/u);

  const tlsError = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("self-signed certificate in certificate chain"), {
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    }),
  });
  const tls = await discoverProviderModels(
    { baseUrl: "https://relay.example.com/v1", apiFormat: "openai-chat-completions" },
    { fetch: fakeFetch(() => tlsError).fetch },
  );
  assert.equal(tls.error?.kind, "tls");
});

test("parseModelListBody accepts OpenAI, Ollama and bare-array shapes", () => {
  assert.deepEqual(parseModelListBody({ data: [{ id: "a" }] })?.models, [{ id: "a" }]);
  assert.deepEqual(parseModelListBody({ models: [{ name: "llama3" }] })?.models, [
    { id: "llama3" },
  ]);
  assert.deepEqual(parseModelListBody(["x", { id: "y" }])?.models, [{ id: "x" }, { id: "y" }]);
  assert.equal(parseModelListBody({ foo: 1 }), null);
});

test("normalizeAnthropicBaseUrl matches the runtime rule", () => {
  assert.equal(
    normalizeAnthropicBaseUrl("https://api.anthropic.com"),
    "https://api.anthropic.com/v1",
  );
  assert.equal(
    normalizeAnthropicBaseUrl("https://x.example.com/anthropic/"),
    "https://x.example.com/anthropic/v1",
  );
  assert.equal(normalizeAnthropicBaseUrl("https://x.example.com/v1"), "https://x.example.com/v1");
});

test("models.dev catalog looks up ids with and without vendor prefix", () => {
  const catalog = buildModelsDevCatalog(catalogData)!;
  assert.equal(catalog.lookup("claude-opus-5-5")?.name, "Claude Opus 5.5");
  assert.equal(catalog.lookup("anthropic/claude-opus-5-5")?.name, "Claude Opus 5.5");
  assert.equal(catalog.lookup("unknown-model"), undefined);
  assert.equal(catalog.modelsForBaseUrl("https://api.anthropic.com").length, 1);
});

test("models.dev source caches to disk for 24h and serves stale cache when offline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "leo-models-dev-"));
  const cacheFilePath = join(dir, "cache", "models-dev-api.json");
  let now = 1_000_000;
  let online = true;
  let requests = 0;
  const fetch = (async () => {
    requests += 1;
    if (!online) throw new TypeError("fetch failed");
    return json(catalogData);
  }) as typeof globalThis.fetch;
  try {
    const source = createModelsDevCatalogSource({ fetch, cacheFilePath, now: () => now });
    assert.ok(await source.load());
    assert.ok(await source.load());
    assert.equal(requests, 1);
    const persisted = JSON.parse(await readFile(cacheFilePath, "utf8"));
    assert.equal(persisted.fetchedAt, 1_000_000);

    // 新进程:读磁盘缓存;过期后联网失败仍返回旧目录。
    online = false;
    now += 25 * 60 * 60_000;
    const restarted = createModelsDevCatalogSource({ fetch, cacheFilePath, now: () => now });
    const stale = await restarted.load();
    assert.equal(stale?.lookup("claude-opus-5-5")?.name, "Claude Opus 5.5");
    assert.equal(requests, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveModelDiscoveryTarget reads key and builtin list from saved config", () => {
  const view = {
    providerTemplates: [
      {
        templateId: "tpl",
        templateNameMap: {},
        config: { builtinModelIds: ["tpl-model"] },
      },
    ],
    providers: [
      {
        providerId: "p1",
        templateId: "tpl",
        enabled: true,
        executable: true,
        issues: [],
        models: [],
        effectiveConfig: {
          access: { type: "api-key" as const, apiKey: " sk-saved " },
          api: { baseUrl: "https://relay.example.com/v1", headers: { "X-Org": "1" } },
        },
      },
    ],
  };
  const target = resolveModelDiscoveryTarget(view, { providerId: "p1" });
  assert.deepEqual(target, {
    baseUrl: "https://relay.example.com/v1",
    apiFormat: "openai-chat-completions",
    apiKey: "sk-saved",
    headers: { "X-Org": "1" },
    builtinModelIds: ["tpl-model"],
  });
  assert.equal(resolveModelDiscoveryTarget(view, { providerId: "missing" }), null);
});
