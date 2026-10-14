import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ApiKeyAccessConfig,
  DEFAULT_CUSTOM_PROVIDER_API_TYPE,
  ProviderApiConfig,
  ProviderConfig,
} from "@zcode/provider";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";
import { getAppConfigDir, setDataBaseDir } from "../src/paths.js";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "leo-provider-defaults-"));
  setDataBaseDir(dir);
  const configDir = getAppConfigDir();
  await mkdir(configDir, { recursive: true });
  const runtime = createProviderConfigRuntime({
    zcodeBuiltinFilePath: fileURLToPath(
      new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    personalFilePath: join(configDir, "personal.json"),
    personalPollingIntervalMs: false,
    watch: false,
  });
  return {
    runtime,
    async dispose() {
      runtime.dispose();
      setDataBaseDir(null);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("new custom provider defaults to openai-chat-completions", async () => {
  const fixture = await setup();
  try {
    await fixture.runtime.start();
    const { providerId } = await fixture.runtime.configService.createPersonalProvider();
    const config = await fixture.runtime.configService.read();
    const rule = config.personalProviders.getRule(providerId);
    assert.equal(DEFAULT_CUSTOM_PROVIDER_API_TYPE, "openai-chat-completions");
    assert.equal(rule?.config.api?.type, "openai-chat-completions");
    assert.equal(rule?.config.access?.type, "api-key");
  } finally {
    await fixture.dispose();
  }
});

test("explicit initial api type still wins over the custom default", async () => {
  const fixture = await setup();
  try {
    await fixture.runtime.start();
    const { providerId } = await fixture.runtime.configService.createPersonalProvider({
      initialConfig: new ProviderConfig({
        api: new ProviderApiConfig({ type: "anthropic-messages" }),
      }),
    });
    const rule = (await fixture.runtime.configService.read()).personalProviders.getRule(providerId);
    assert.equal(rule?.config.api?.type, "anthropic-messages");
  } finally {
    await fixture.dispose();
  }
});

function providerWith(baseUrl: string, type: "openai-chat-completions" | "anthropic-messages") {
  return new ProviderConfig({
    group: "standard-personal",
    access: new ApiKeyAccessConfig({ apiKey: "" }),
    api: new ProviderApiConfig({ type, baseUrl }),
  });
}

test("local OpenAI-compatible endpoints are admitted without an API key", () => {
  const issues = (config: ProviderConfig) =>
    config.validateComplete(["p"]).map((issue) => issue.path.join("."));
  assert.deepEqual(
    issues(providerWith("http://localhost:11434/v1", "openai-chat-completions")),
    [],
  );
  assert.deepEqual(issues(providerWith("http://127.0.0.1:1234/v1", "openai-chat-completions")), []);
  // 远端地址、以及运行时必须有 Key 的 Anthropic SDK,仍然要求填写 Key。
  assert.deepEqual(
    issues(providerWith("https://relay.example.com/v1", "openai-chat-completions")),
    ["p.access.apiKey"],
  );
  assert.deepEqual(issues(providerWith("http://localhost:11434", "anthropic-messages")), [
    "p.access.apiKey",
  ]);
});
