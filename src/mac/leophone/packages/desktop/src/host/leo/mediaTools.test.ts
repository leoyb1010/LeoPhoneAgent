import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { createMediaMcpServer, extractImages, type MediaProvider } from "./mediaTools.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
const provider: MediaProvider = {
  name: "gw",
  baseUrl: "https://gw.example/v1",
  apiKey: "k",
  modelIds: ["go/kimi-k3.1-pro", "gemini-3.1-flash-image"],
};

function stubFetch(routes: Record<string, unknown>, calls: string[]): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const body = Object.entries(routes).find(([suffix]) => url.endsWith(suffix))?.[1];
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

test("extractImages reads b64_json, chat message.images and data URLs in content", () => {
  assert.equal(extractImages({ data: [{ b64_json: PNG }] }).length, 1);
  const chat = extractImages({
    choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${PNG}` } }] } }],
  });
  assert.equal(chat.length, 1);
  assert.equal("ext" in chat[0]! && chat[0].ext, "png");
  assert.equal(
    extractImages({ choices: [{ message: { content: `![x](data:image/jpeg;base64,${PNG})` } }] }).length,
    1,
  );
  assert.deepEqual(extractImages({ choices: [{ message: { content: "no image" } }] }), []);
});

test("generate_image picks the configured image model, saves the file and returns embeddable markdown", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "leo-media-"));
  try {
    const calls: string[] = [];
    const server = createMediaMcpServer({
      providers: async () => [provider],
      fetch: stubFetch(
        { "/chat/completions": { choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${PNG}` } }] } }] } },
        calls,
      ),
      outputDir: dir,
      now: () => new Date(2026, 9, 24, 8, 9, 10),
    });
    const result = await server.callTool("generate_image", { prompt: "一只猫" });
    const text = String(result.content[0]!["text"]);
    assert.equal(result.isError, undefined);
    // Gemini 系先走 chat/completions,一次就出图
    assert.deepEqual(calls, ["https://gw.example/v1/chat/completions"]);
    const path = resolve(dir, "2026-10-24", "080910-1.png");
    assert.ok(existsSync(path));
    assert.equal(readFileSync(path).toString("base64"), PNG);
    assert.match(text, /gemini-3\.1-flash-image/u);
    assert.ok(text.includes(`![一只猫](<${path}>)`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate_image falls back to the gateway model list and the images endpoint", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "leo-media-"));
  try {
    const calls: string[] = [];
    const server = createMediaMcpServer({
      providers: async () => [{ ...provider, modelIds: ["go/kimi-k3.1-pro"] }],
      fetch: stubFetch(
        {
          "/models": { data: [{ id: "grok-4.7" }, { id: "grok-imagine-video" }, { id: "grok-imagine-image" }] },
          "/images/generations": { data: [{ b64_json: PNG }] },
        },
        calls,
      ),
      outputDir: dir,
    });
    const result = await server.callTool("generate_image", { prompt: "apple" });
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, ["https://gw.example/v1/models", "https://gw.example/v1/images/generations"]);
    assert.match(String(result.content[0]!["text"]), /grok-imagine-image/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate_image reports a clear error when no image model is available", async () => {
  const server = createMediaMcpServer({
    providers: async () => [{ ...provider, modelIds: [] }],
    fetch: stubFetch({ "/models": { data: [{ id: "grok-4.7" }] } }, []),
  });
  const result = await server.callTool("generate_image", { prompt: "apple" });
  assert.equal(result.isError, true);
  assert.match(String(result.content[0]!["text"]), /没有可用的生图模型/u);
});
