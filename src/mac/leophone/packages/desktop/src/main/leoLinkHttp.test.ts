import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

const seen: { method?: string; url?: string; auth?: string; pair?: string; body: string }[] = [];
const server = createServer((req: IncomingMessage, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    seen.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      pair: req.headers["x-leo-pair"] as string | undefined,
      body,
    });
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/leo/health") return res.end(JSON.stringify({ app: "leophoneagent-1.x" }));
    if (req.url?.startsWith("/api/leo/link/fail")) {
      res.statusCode = 409;
      return res.end(JSON.stringify({ error: "busy" }));
    }
    res.end(JSON.stringify({ connected: true }));
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
process.env["LEOAGENT_PORT"] = String((server.address() as AddressInfo).port);
process.env["LEOAGENT_KEY"] = "test-key-0123456789abcdef";
const { callLeo, leoOAuthPageUrl, ownHostListening } = await import("./leoLinkHttp.js");
after(() => server.close());

test("callLeo returns the Leo API JSON (regression: TDZ ReferenceError on every call)", async () => {
  assert.deepEqual(await callLeo("/api/leo/link/status", "GET"), {
    ok: true,
    data: { connected: true },
  });
  const status = seen.at(-1)!;
  assert.equal(status.auth, "Bearer test-key-0123456789abcdef");
  assert.equal(status.body, "");
});

test("callLeo forwards JSON body and pair header, and maps API errors", async () => {
  await callLeo("/api/leo/link/direct/configure", "POST", { "x-leo-pair": "p" }, { a: 1 });
  assert.equal(seen.at(-1)!.body, '{"a":1}');
  assert.equal(seen.at(-1)!.pair, "p");
  assert.deepEqual(await callLeo("/api/leo/link/fail", "POST"), { ok: false, error: "busy" });
});

test("ownHostListening recognises our Host", async () => {
  assert.equal(await ownHostListening(), true);
});

test("the OAuth page URL carries the UI secret only in the fragment", () => {
  const url = new URL(leoOAuthPageUrl(40123, "s3cr/et+"));
  assert.equal(url.origin, "http://127.0.0.1:40123");
  assert.equal(url.pathname, "/leo/oauth");
  assert.equal(url.search, "");
  assert.equal(new URLSearchParams(url.hash.slice(1)).get("t"), "s3cr/et+");
});
