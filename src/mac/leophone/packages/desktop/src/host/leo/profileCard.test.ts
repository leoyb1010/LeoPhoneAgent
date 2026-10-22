import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readBrainStatus, resetBrainStatusCacheForTests, type BrainFetch } from "./brainGateway.js";
import {
  capUtf8,
  parseProfileMeta,
  PROFILE_CARD_TITLE,
  PROFILE_MAX_BYTES,
  syncProfileCardOnce,
} from "./profileCard.js";

const logger = { info: () => {}, warn: () => {} };

type Route = (url: URL, init: RequestInit) => { status: number; body?: unknown };

function fakeFetch(route: Route) {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const fetch: BrainFetch = async (raw, init) => {
    const url = new URL(raw);
    calls.push({ url, headers: init.headers as Record<string, string> });
    const { status, body } = route(url, init);
    return new Response(body === undefined ? "" : JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

function sandbox(run: (paths: { keyFile: string; filePath: string; dir: string }) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "leo-profile-"));
    const keyFile = join(dir, "leobot-mac.key");
    writeFileSync(keyFile, "secret-key\n", { mode: 0o600 });
    try {
      await run({ keyFile, filePath: join(dir, "home", ".leophoneagent", "leo-profile.md"), dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const card = (patch: Record<string, unknown> = {}) => ({
  id: "card-1",
  title: PROFILE_CARD_TITLE,
  category: "用户画像",
  body: "我是 Leo，做产品。回答尽量简短。",
  status: "confirmed",
  version: 3,
  updated_at: "2026-10-22T10:00:00+08:00",
  ...patch,
});

test(
  "no key file: skips without touching the network",
  sandbox(async ({ dir, filePath }) => {
    const { fetch, calls } = fakeFetch(() => ({ status: 500 }));
    const result = await syncProfileCardOnce({ logger, filePath, keyFile: join(dir, "missing.key"), fetch });
    assert.equal(result, "no-key");
    assert.equal(calls.length, 0);
  }),
);

test(
  "first sync finds the card by exact title, writes a capped managed file with UA + bearer",
  sandbox(async ({ keyFile, filePath }) => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname === "/v1/search")
        return {
          status: 200,
          body: {
            items: [
              { type: "card", id: "other", title: "资料提炼 · Leo 画像集.pdf", category: "资料提炼" },
              { type: "card", id: "card-1", title: PROFILE_CARD_TITLE, category: "用户画像" },
            ],
          },
        };
      if (url.pathname === "/v1/cards/card-1") return { status: 200, body: card() };
      return { status: 404 };
    });
    assert.equal(await syncProfileCardOnce({ logger, filePath, keyFile, fetch }), "written");
    const text = readFileSync(filePath, "utf8");
    assert.match(text, /由 iPhone 同步，勿手改/);
    assert.match(text, /我是 Leo，做产品。/);
    assert.deepEqual(parseProfileMeta(text), {
      id: "card-1",
      version: "3",
      updatedAt: "2026-10-22T10:00:00+08:00",
    });
    assert.equal(calls[0]!.url.searchParams.get("q"), PROFILE_CARD_TITLE);
    assert.equal(calls[0]!.headers["Authorization"], "Bearer secret-key");
    assert.match(calls[0]!.headers["User-Agent"]!, /^LeoBotMac\//);
  }),
);

test(
  "later syncs go straight to the card id and do not rewrite an unchanged version",
  sandbox(async ({ keyFile, filePath }) => {
    let current = card();
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname === "/v1/search") return { status: 200, body: { items: [{ type: "card", id: "card-1", title: PROFILE_CARD_TITLE }] } };
      if (url.pathname === "/v1/cards/card-1") return { status: 200, body: current };
      return { status: 404 };
    });
    await syncProfileCardOnce({ logger, filePath, keyFile, fetch });
    calls.length = 0;
    assert.equal(await syncProfileCardOnce({ logger, filePath, keyFile, fetch }), "unchanged");
    assert.deepEqual(
      calls.map((call) => call.url.pathname),
      ["/v1/cards/card-1"],
    );
    current = card({ version: 4, body: "新画像" });
    assert.equal(await syncProfileCardOnce({ logger, filePath, keyFile, fetch }), "written");
    assert.match(readFileSync(filePath, "utf8"), /新画像/);
  }),
);

test(
  "missing card writes nothing; a deleted card removes the stale synced file",
  sandbox(async ({ keyFile, filePath }) => {
    let exists = false;
    const { fetch } = fakeFetch((url) => {
      if (url.pathname === "/v1/search")
        return { status: 200, body: { items: exists ? [{ type: "card", id: "card-1", title: PROFILE_CARD_TITLE }] : [] } };
      if (url.pathname === "/v1/cards") return { status: 200, body: { items: [] } };
      if (url.pathname === "/v1/cards/card-1" && exists) return { status: 200, body: card() };
      return { status: 404 };
    });
    assert.equal(await syncProfileCardOnce({ logger, filePath, keyFile, fetch }), "missing");
    assert.equal(existsSync(filePath), false);
    exists = true;
    assert.equal(await syncProfileCardOnce({ logger, filePath, keyFile, fetch }), "written");
    exists = false;
    assert.equal(await syncProfileCardOnce({ logger, filePath, keyFile, fetch }), "removed");
    assert.equal(existsSync(filePath), false);
  }),
);

test(
  "gateway errors keep the previous profile",
  sandbox(async ({ keyFile, filePath }) => {
    const ok = fakeFetch((url) =>
      url.pathname === "/v1/search"
        ? { status: 200, body: { items: [{ type: "card", id: "card-1", title: PROFILE_CARD_TITLE }] } }
        : { status: 200, body: card() },
    );
    await syncProfileCardOnce({ logger, filePath, keyFile, fetch: ok.fetch });
    const before = readFileSync(filePath, "utf8");
    const down = fakeFetch(() => ({ status: 502 }));
    assert.equal(await syncProfileCardOnce({ logger, filePath, keyFile, fetch: down.fetch }), "failed");
    assert.equal(readFileSync(filePath, "utf8"), before);
  }),
);

test("body is capped at 2KB on a character boundary", () => {
  const long = "画".repeat(1000); // 3000 bytes
  const { text, truncated } = capUtf8(long, PROFILE_MAX_BYTES);
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(text) <= PROFILE_MAX_BYTES);
  assert.equal(text, "画".repeat(682));
});

test(
  "brain status reads card / file counts from /v1/health, disabled without key",
  sandbox(async ({ keyFile, dir }) => {
    resetBrainStatusCacheForTests();
    const none = await readBrainStatus({ keyFile: join(dir, "missing.key") });
    assert.deepEqual(none, { enabled: false, cards: null, files: null });
    resetBrainStatusCacheForTests();
    const { fetch } = fakeFetch((url) =>
      url.pathname === "/v1/health"
        ? { status: 200, body: { ok: true, archive: { files: 52037, cards: 1551 } } }
        : { status: 404 },
    );
    assert.deepEqual(await readBrainStatus({ keyFile, fetch }), { enabled: true, cards: 1551, files: 52037 });
    resetBrainStatusCacheForTests();
    const down = fakeFetch(() => ({ status: 503 }));
    assert.deepEqual(await readBrainStatus({ keyFile, fetch: down.fetch }), {
      enabled: true,
      cards: null,
      files: null,
      error: "HTTP 503",
    });
  }),
);
