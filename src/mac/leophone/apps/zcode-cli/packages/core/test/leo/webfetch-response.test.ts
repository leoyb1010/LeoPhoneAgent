import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import https from "node:https";
import os from "node:os";
import { PassThrough, Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { createNodeWebFetchHttpClientAdapter } from "../../../adapters/src/http/index.js";
import { fetchAndExtractContent } from "../../src/tool/handlers/webfetch-network.js";
import { MAX_WEBFETCH_RESPONSE_BYTES } from "../../src/tool/handlers/webfetch-constants.js";
import type { ToolExecutionContext } from "../../src/tool/types.js";

const ARTICLE = "Public article readable text.";
type Fixture = { status?: number; headers?: Record<string, string>; bytes?: Buffer; stream?: PassThrough };

// 真正 WebFetch → adapter，只有 Node HTTPS 边缘换为异步响应，测试不发网络请求。
function harness(t: TestContext, fixtures: Fixture[], signal = new AbortController().signal) {
  const messages: IncomingMessage[] = [];
  let count = 0;
  let lookups = 0;
  t.mock.method(https, "request", ((options: RequestOptions, callback: (message: IncomingMessage) => void) => {
    assert.equal(typeof options.lookup, "function"); // public connection-bound DNS remains installed
    const fixture = fixtures[count++];
    assert.ok(fixture, "unexpected request");
    const request = new EventEmitter() as ClientRequest;
    request.end = (() => {
      queueMicrotask(() => {
        const message = (fixture.stream ?? Readable.from(fixture.bytes ? [fixture.bytes] : [], { objectMode: false })) as IncomingMessage;
        message.statusCode = fixture.status ?? 200;
        message.statusMessage = "fixture";
        message.headers = { "content-type": "text/plain", ...fixture.headers };
        messages.push(message);
        callback(message);
      });
      return request;
    }) as ClientRequest["end"];
    return request;
  }) as typeof https.request);
  const port = createNodeWebFetchHttpClientAdapter({
    env: {}, noProxy: "*", timeoutMs: 1000,
    dnsLookup: async () => { lookups += 1; return [{ address: "93.184.216.34", family: 4 }]; },
  });
  const context: ToolExecutionContext = {
    httpClientPort: port, abortSignal: signal, toolCallId: "webfetch-response-fixture",
    workingDirectory: os.tmpdir(), workspaceRoot: os.tmpdir(),
  };
  return {
    messages, count: () => count, lookups: () => lookups,
    fetch: () => fetchAndExtractContent({ context, originalUrl: "https://public.example/article", url: new URL("https://public.example/article") }),
  };
}

for (const status of [204, 205, 304]) {
  test(`real WebFetch survives raw null-body status ${status}`, async (t) => {
    const fixture = harness(t, [{ status }]);
    const result = await fixture.fetch();
    assert.equal(result.status, status);
    if ("content" in result) assert.equal(result.content, "");
    assert.equal(fixture.messages[0]!.destroyed, true);
    assert.equal(fixture.lookups(), 1);
  });
}

for (const response of [{ status: 99 }, { headers: { "invalid header": "bad" } }]) {
  test(`malformed raw response rejects the awaited WebFetch call: ${JSON.stringify(response)}`, async (t) => {
    const fixture = harness(t, [response]);
    await assert.rejects(fixture.fetch(), /status|header/i);
    assert.equal(fixture.messages[0]!.destroyed, true);
  });
}

for (const [encoding, encode] of [
  ["identity", (value: string) => Buffer.from(value)],
  ["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync],
  ["deflate", deflateRawSync],
] as const) {
  test(`real WebFetch extracts decoded ${encoding} content`, async (t) => {
    const bytes = encode(ARTICLE);
    const fixture = harness(t, [{ bytes, headers: { "content-encoding": encoding, "content-length": String(bytes.length) } }]);
    const result = await fixture.fetch();
    assert.ok("content" in result);
    assert.equal(result.content, ARTICLE);
    assert.equal(result.bytes, Buffer.byteLength(ARTICLE));
  });
}

test("compressed same-host redirects preserve content and public DNS checks", async (t) => {
  const fixture = harness(t, [
    { status: 302, headers: { location: "/final", "content-encoding": "gzip" }, bytes: gzipSync("redirect") },
    { bytes: brotliCompressSync(ARTICLE), headers: { "content-encoding": "br" } },
  ]);
  const result = await fixture.fetch();
  assert.ok("content" in result);
  assert.equal(result.content, ARTICLE);
  assert.equal(result.finalUrl, "https://public.example/final");
  assert.equal(fixture.count(), 2);
  assert.equal(fixture.lookups(), 2);
});

test("stacked content codings decode in reverse wire order", async (t) => {
  const fixture = harness(t, [{ bytes: gzipSync(deflateSync(ARTICLE)), headers: { "content-encoding": "deflate, gzip" } }]);
  const result = await fixture.fetch();
  assert.ok("content" in result);
  assert.equal(result.content, ARTICLE);
});

for (const encoding of ["gzip", "deflate", "br"]) {
  test(`corrupt ${encoding} rejects normally and destroys the response`, async (t) => {
    const fixture = harness(t, [{ bytes: Buffer.from("invalid compressed bytes"), headers: { "content-encoding": encoding } }]);
    await assert.rejects(fixture.fetch());
    assert.equal(fixture.messages[0]!.destroyed, true);
  });
}

for (const [encoding, encode] of [["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync]] as const) {
  test(`decoded bytes, not small ${encoding} wire length, enforce the WebFetch limit`, async (t) => {
    const bytes = encode(Buffer.alloc(MAX_WEBFETCH_RESPONSE_BYTES + 1, "a"));
    assert.ok(bytes.length < MAX_WEBFETCH_RESPONSE_BYTES);
    const fixture = harness(t, [{ bytes, headers: { "content-encoding": encoding, "content-length": String(bytes.length) } }]);
    await assert.rejects(fixture.fetch(), /too large/i);
    assert.equal(fixture.messages[0]!.destroyed, true);
  });

  test(`cancelling ${encoding} closes its source and rejects through WebFetch`, async (t) => {
    const stream = new PassThrough();
    const abort = new AbortController();
    const fixture = harness(t, [{ stream, headers: { "content-encoding": encoding } }], abort.signal);
    const rejected = assert.rejects(fixture.fetch(), /abort|cancel/i);
    await new Promise<void>((resolve) => setImmediate(resolve));
    stream.write(encode(ARTICLE).subarray(0, 2));
    abort.abort();
    await rejected;
    assert.equal(stream.destroyed, true);
  });
}

for (const encode of [deflateSync, deflateRawSync]) {
  test(`chunked ${encode.name} handles split headers and output backpressure`, { timeout: 3000 }, async (t) => {
    const content = ARTICLE.repeat(3000);
    const bytes = encode(content);
    const stream = new PassThrough();
    const fixture = harness(t, [{ stream, headers: { "content-encoding": "deflate" } }]);
    const pending = fixture.fetch();
    stream.write(bytes.subarray(0, 1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    stream.end(bytes.subarray(1));
    const result = await pending;
    assert.ok("content" in result);
    assert.equal(result.content, content);
  });
}
