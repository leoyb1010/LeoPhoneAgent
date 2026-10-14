import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConfigObject, ProviderSettingsView } from "@zcode/provider";
import {
  decideImport,
  decodeIosSecret,
  mapIosProvider,
  parseIosProviderFile,
  type IosProviderExport,
  type MappedIosProvider,
} from "../src/model-provider/iosProviderImport.js";
import {
  executeProviderImport,
  type ProviderImportTarget,
} from "../src/model-provider/iosProviderImportExecutor.js";

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

function item(extra: Partial<IosProviderExport> & { providerType: string }): IosProviderExport {
  return { label: "My Provider", credentialType: "apiKey", models: [], ...extra };
}

function mapped(extra: Partial<IosProviderExport> & { providerType: string }): MappedIosProvider {
  const result = mapIosProvider(item(extra));
  assert.equal(result.kind, "provider", JSON.stringify(result));
  return result as MappedIosProvider;
}

test("maps every supported iOS provider type to a Mac protocol and base URL", () => {
  const cases: Array<[string, string | undefined, string, string]> = [
    ["openAI", undefined, "openai-chat-completions", "https://api.openai.com/v1"],
    [
      "openAI",
      "https://relay.example.com",
      "openai-chat-completions",
      "https://relay.example.com/v1",
    ],
    [
      "openAI",
      "https://relay.example.com/v1/",
      "openai-chat-completions",
      "https://relay.example.com/v1",
    ],
    ["openAIResponses", undefined, "openai-responses", "https://api.openai.com/v1"],
    ["anthropic", undefined, "anthropic-messages", "https://api.anthropic.com"],
    [
      "anthropic",
      "https://gw.example.com/anthropic/",
      "anthropic-messages",
      "https://gw.example.com/anthropic",
    ],
    ["openRouter", undefined, "openai-chat-completions", "https://openrouter.ai/api/v1"],
    ["xAI", undefined, "openai-chat-completions", "https://api.x.ai/v1"],
    [
      "gemini",
      "https://ignored.example.com",
      "openai-chat-completions",
      "https://generativelanguage.googleapis.com/v1beta/openai",
    ],
    ["kimiCode", undefined, "openai-chat-completions", "https://api.kimi.com/coding/v1"],
  ];
  for (const [providerType, customBaseURL, apiType, baseUrl] of cases) {
    const result = mapped({ providerType, ...(customBaseURL ? { customBaseURL } : {}) });
    assert.equal(result.apiType, apiType, providerType);
    assert.equal(result.baseUrl, baseUrl, `${providerType} ${customBaseURL ?? ""}`);
  }
});

test("appendV1Suffix=false keeps the custom base URL as-is", () => {
  const result = mapped({
    providerType: "openAI",
    customBaseURL: "https://ark.example.com/api/v3/",
    appendV1Suffix: false,
  });
  assert.equal(result.baseUrl, "https://ark.example.com/api/v3");
});

test("skip reasons: OpenCode Go, OAuth-only, Azure, unknown type, bad URL", () => {
  const reason = (extra: Partial<IosProviderExport> & { providerType: string }) => {
    const result = mapIosProvider(item(extra));
    return result.kind === "skipped" ? result.reason : "imported";
  };
  assert.equal(reason({ providerType: "openCodeGo", apiKey: b64("k") }), "opencode-go");
  assert.equal(reason({ providerType: "openAI", credentialType: "oauth" }), "oauth-only");
  assert.equal(
    reason({ providerType: "xAI", credentialType: "oauth", secretsOmitted: true }),
    "oauth-only",
  );
  assert.equal(reason({ providerType: "openAI", azureMode: true, apiKey: b64("k") }), "azure");
  assert.equal(reason({ providerType: "someFutureType" }), "unsupported-type");
  assert.equal(reason({ providerType: "openAI", customBaseURL: "ftp://x" }), "invalid-base-url");
  // 手动 token 的 OAuth 实例与 OpenRouter 登录生成的 Key 都可导入。
  assert.equal(
    reason({ providerType: "xAI", credentialType: "oauth", manualOAuthToken: b64("xai-token") }),
    "imported",
  );
  assert.equal(reason({ providerType: "openRouter", credentialType: "oauth" }), "imported");
});

test("keys: base64 decoded, plain text fallback, manual token as bearer key", () => {
  assert.equal(decodeIosSecret(b64("sk-ant-api03-abc_DEF")), "sk-ant-api03-abc_DEF");
  assert.equal(decodeIosSecret("sk-plain-key-123"), "sk-plain-key-123");
  // 十六进制明文 Key 恰好是合法 base64 字符集,但解出来是乱码,应按明文处理。
  assert.equal(
    decodeIosSecret("0123456789abcdef0123456789abcdef"),
    "0123456789abcdef0123456789abcdef",
  );
  assert.equal(decodeIosSecret("  "), undefined);
  assert.equal(mapped({ providerType: "openAI", apiKey: b64("sk-1") }).apiKey, "sk-1");
  assert.equal(
    mapped({ providerType: "openAI", manualOAuthToken: b64("bearer-1") }).apiKey,
    "bearer-1",
  );
  assert.equal(mapped({ providerType: "openAI", secretsOmitted: true }).apiKey, undefined);
});

test("models: hidden skipped, overrides win, modality bit 4 means vision, user agent header", () => {
  const result = mapped({
    providerType: "anthropic",
    customUserAgent: "LeoBot/1.0",
    models: [
      {
        modelId: "claude-opus-5-5",
        displayName: "Opus",
        isHidden: false,
        contextWindow: 200000,
        maxOutputTokens: 32000,
        modalityOverride: 7,
        overrides: { contextWindow: 1000000 },
      },
      { modelId: "claude-old", isHidden: true },
      { modelId: "plain-model" },
      { nope: true },
    ],
  });
  assert.deepEqual(result.models, [
    { id: "claude-opus-5-5", contextWindow: 1000000, maxOutput: 32000, vision: true },
    { id: "plain-model" },
  ]);
  assert.deepEqual(result.headers, { "User-Agent": "LeoBot/1.0" });
});

test("files: single object, array, providers wrapper and invalid JSON", () => {
  const one = JSON.stringify(item({ providerType: "openAI" }));
  assert.equal(parseIosProviderFile("a.json", one).entries.length, 1);
  const many = JSON.stringify([
    item({ providerType: "openAI" }),
    item({ providerType: "openCodeGo" }),
  ]);
  assert.deepEqual(
    parseIosProviderFile("b.json", many).entries.map((entry) => entry.kind),
    ["provider", "skipped"],
  );
  const wrapped = JSON.stringify({ providers: [item({ providerType: "xAI" })] });
  assert.equal(parseIosProviderFile("c.json", wrapped).entries[0]!.kind, "provider");
  const bad = parseIosProviderFile("d.json", "{not json").entries[0]!;
  assert.equal(bad.kind === "skipped" && bad.reason, "invalid-file");
  const missingLabel = parseIosProviderFile("e.json", JSON.stringify({ providerType: "openAI" }))
    .entries[0]!;
  assert.equal(missingLabel.kind === "skipped" && missingLabel.reason, "invalid-file");
});

test("dedupe: same label + base URL updates; label conflict appends (2)", () => {
  const existing = [
    { providerId: "p1", label: "Relay", baseUrl: "https://relay.example.com/v1/" },
    { providerId: "p2", label: "Other", baseUrl: "https://x" },
    { providerId: "p3", label: "Other (2)", baseUrl: "https://y" },
  ];
  assert.deepEqual(
    decideImport({ label: "Relay", baseUrl: "https://RELAY.example.com/v1" }, existing),
    {
      action: "update",
      providerId: "p1",
    },
  );
  assert.deepEqual(
    decideImport({ label: "Relay", baseUrl: "https://other.example.com/v1" }, existing),
    {
      action: "create",
      label: "Relay (2)",
    },
  );
  assert.deepEqual(decideImport({ label: "Other", baseUrl: "https://z" }, existing), {
    action: "create",
    label: "Other (3)",
  });
  assert.deepEqual(decideImport({ label: "New", baseUrl: "https://z" }, existing), {
    action: "create",
    label: "New",
  });
});

/** 内存版 facade:只模拟导入用到的几个操作。 */
function memoryTarget() {
  interface P {
    providerId: string;
    providerName: string;
    config: ProviderConfigObject;
    models: string[];
  }
  const providers: P[] = [];
  const calls: string[] = [];
  const view = (): ProviderSettingsView =>
    ({
      revision: 1,
      providerTemplates: [],
      providerOrder: providers.map((p) => p.providerId),
      providers: providers.map((p) => ({
        providerId: p.providerId,
        providerName: p.providerName,
        enabled: true,
        executable: true,
        issues: [],
        effectiveConfig: p.config,
        personalConfig: p.config,
        models: p.models.map((modelId) => ({ modelId })),
      })),
    }) as unknown as ProviderSettingsView;
  const target = {
    getView: view,
    waitForProviderOperations: async () => {},
    createPersonalProvider: async (input?: {
      providerName?: string;
      initialConfig?: ProviderConfigObject;
    }) => {
      const providerId = `custom-${providers.length + 1}`;
      providers.push({
        providerId,
        providerName: input?.providerName ?? providerId,
        config: input?.initialConfig ?? {},
        models: [],
      });
      calls.push(`create:${input?.providerName}`);
      return { providerId, view: view() };
    },
    savePersonalProviderOverlay: async (providerId: string, config: ProviderConfigObject) => {
      providers.find((p) => p.providerId === providerId)!.config = config;
      calls.push(`save:${providerId}`);
      return view();
    },
    addPersonalModel: async (providerId: string, modelId: string) => {
      providers.find((p) => p.providerId === providerId)!.models.push(modelId);
      return view();
    },
  } as unknown as ProviderImportTarget;
  return { target, providers, calls };
}

test("execute: create, re-import updates and merges, secrets-omitted needs key, keyless local ok", async () => {
  const { target, providers, calls } = memoryTarget();
  const exportJson = (extra: Partial<IosProviderExport>) =>
    JSON.stringify(
      item({
        providerType: "openAI",
        label: "Relay",
        customBaseURL: "https://relay.example.com",
        models: [{ modelId: "gpt-5.5" }],
        ...extra,
      }),
    );

  const first = await executeProviderImport(target, {
    files: [{ name: "relay.json", content: exportJson({ secretsOmitted: true }) }],
  });
  assert.deepEqual(
    first.items.map((i) => [i.status, i.needsKey, i.modelCount]),
    [["imported", true, 1]],
  );
  assert.equal(providers[0]!.config.api?.baseUrl, "https://relay.example.com/v1");
  assert.equal(providers[0]!.config.api?.type, "openai-chat-completions");

  const second = await executeProviderImport(target, {
    files: [
      {
        name: "relay.json",
        content: exportJson({
          apiKey: b64("sk-new"),
          models: [{ modelId: "gpt-5.5" }, { modelId: "gpt-5" }],
        }),
      },
    ],
  });
  assert.equal(providers.length, 1, "同名同地址不应重复创建");
  assert.deepEqual(
    second.items.map((i) => [i.status, i.needsKey, i.modelCount]),
    [["updated", false, 1]],
  );
  const access = providers[0]!.config.access;
  assert.equal(access?.type !== "zhipu-account" ? access?.apiKey : undefined, "sk-new");
  assert.deepEqual(providers[0]!.models, ["gpt-5.5", "gpt-5"]);
  assert.ok(calls.includes("save:custom-1"));

  const local = await executeProviderImport(target, {
    files: [
      {
        name: "ollama.json",
        content: JSON.stringify(
          item({
            providerType: "openAI",
            label: "Ollama",
            customBaseURL: "http://localhost:11434",
            secretsOmitted: true,
          }),
        ),
      },
    ],
  });
  assert.equal(local.items[0]!.needsKey, false);
  // 结果里不得出现任何 Key。
  assert.equal(JSON.stringify(second).includes("sk-new"), false);
});
