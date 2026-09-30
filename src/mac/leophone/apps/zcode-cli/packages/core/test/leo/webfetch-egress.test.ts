import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import type { HttpClientPort, HttpClientRequest } from "@zcode/contracts";
import { createNodeWebFetchHttpClientAdapter } from "../../../adapters/src/http/index.js";
import { createPublicEgressLookup } from "../../../adapters/src/http/public-egress-policy.js";
import { fetchAndExtractContent } from "../../src/tool/handlers/webfetch-network.js";
import type { ToolExecutionContext } from "../../src/tool/types.js";

const context = (httpClientPort: HttpClientPort): ToolExecutionContext => ({
  httpClientPort,
  toolCallId: "webfetch-audit",
  traceId: "trace-fixture" as ToolExecutionContext["traceId"],
  sessionId: "session-fixture" as ToolExecutionContext["sessionId"],
  workingDirectory: os.tmpdir(),
  workspaceRoot: os.tmpdir(),
  abortSignal: new AbortController().signal,
});

const fetchWith = (port: HttpClientPort) => fetchAndExtractContent({
  context: context(port), originalUrl: "https://public.example/article", url: new URL("https://public.example/article"),
});

test("WebFetch sends public egress policy for the first GET and each same-host redirect", async () => {
  const seen: HttpClientRequest[] = [];
  const port: HttpClientPort = {
    async request(request) {
      seen.push(request);
      const body = new TextEncoder().encode("A public article.");
      return {
        url: request.url, status: seen.length === 1 ? 302 : 200, statusText: "OK",
        headers: seen.length === 1 ? { location: "/final" } : { "content-type": "text/plain" },
        body, bytes: body.length, durationMs: 1,
      };
    },
  };
  await fetchWith(port);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((request) => request.egressPolicy), ["public", "public"]);
  assert.equal(seen[1]?.url, "https://public.example/final");
});

for (const addresses of [
  [{ address: "127.0.0.1", family: 4 }],
  [{ address: "10.1.2.3", family: 4 }],
  [{ address: "fd00::1", family: 6 }],
  [{ address: "93.184.216.34", family: 4 }, { address: "192.168.1.2", family: 4 }],
]) {
  test(`WebFetch default adapter rejects DNS result ${addresses.map((row) => row.address).join(",")}`, async () => {
    let lookups = 0;
    const port = createNodeWebFetchHttpClientAdapter({
      env: {}, noProxy: "*", timeoutMs: 1000,
      dnsLookup: async () => { lookups += 1; return addresses; },
    });
    await assert.rejects(fetchWith(port), /non-public|egress|blocked/i);
    assert.equal(lookups, 1); // Rejected by validation before a socket is opened.
  });
}

test("connection-bound lookup rejects a rebinding result and preserves public results", async () => {
  let address = "93.184.216.34";
  const lookup = createPublicEgressLookup("https://public.example", async () => [{ address, family: 4 }]);
  const resolve = () => new Promise<unknown>((accept, reject) => {
    lookup("public.example", {}, (error, value) => error ? reject(error) : accept(value));
  });
  assert.equal(await resolve(), address);
  address = "127.0.0.1";
  await assert.rejects(resolve(), /non-public/i);
});
