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

function sandbox(
  run: (paths: { keyFile: string; filePath: string; dir: string }) => Promise<void>,
) {
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
    const result = await syncProfileCardOnce({
      logger,
      filePath,
      keyFile: join(dir, "missing.key"),
      fetch,
    });
    assert.equal(result, "no-key");
    assert.equal(calls.length, 0);
  }),
);

test(
  "key removed after a sync: the managed profile is deleted, a hand-written file is left alone",
  sandbox(async ({ keyFile, filePath, dir }) => {
    const ok = fakeFetch((url) =>
      url.pathname === "/v1/search"
        ? {
            status: 200,
            body: { items: [{ type: "card", id: "card-1", title: PROFILE_CARD_TITLE }] },
          }
        : { status: 200, body: card() },
    );
    assert.equal(
      await syncProfileCardOnce({ logger, filePath, keyFile, fetch: ok.fetch }),
      "written",
    );
    const missingKey = join(dir, "missing.key");
    assert.equal(
      await syncProfileCardOnce({ logger, filePath, keyFile: missingKey, fetch: ok.fetch }),
      "no-key",
    );
    assert.equal(existsSync(filePath), false);
    writeFileSync(filePath, "我自己写的画像\n");
    assert.equal(
      await syncProfileCardOnce({ logger, filePath, keyFile: missingKey, fetch: ok.fetch }),
      "no-key",
    );
    assert.equal(readFileSync(filePath, "utf8"), "我自己写的画像\n");
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
              {
                type: "card",
                id: "other",
                title: "资料提炼 · Leo 画像集.pdf",
                category: "资料提炼",
              },
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
  "later syncs re-check the title search, reuse the known card and do not rewrite an unchanged version",
  sandbox(async ({ keyFile, filePath }) => {
    let current = card();
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname === "/v1/search")
        return {
          status: 200,
          body: { items: [{ type: "card", id: "card-1", title: PROFILE_CARD_TITLE }] },
        };
      if (url.pathname === "/v1/cards/card-1") return { status: 200, body: current };
      return { status: 404 };
    });
    await syncProfileCardOnce({ logger, filePath, keyFile, fetch });
    calls.length = 0;
    assert.equal(await syncProfileCardOnce({ logger, filePath, keyFile, fetch }), "unchanged");
    assert.deepEqual(
      calls.map((call) => call.url.pathname),
      ["/v1/search", "/v1/cards/card-1"],
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
        return {
          status: 200,
          body: {
            items: exists ? [{ type: "card", id: "card-1", title: PROFILE_CARD_TITLE }] : [],
          },
        };
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
        ? {
            status: 200,
            body: { items: [{ type: "card", id: "card-1", title: PROFILE_CARD_TITLE }] },
          }
        : { status: 200, body: card() },
    );
    await syncProfileCardOnce({ logger, filePath, keyFile, fetch: ok.fetch });
    const before = readFileSync(filePath, "utf8");
    const down = fakeFetch(() => ({ status: 502 }));
    assert.equal(
      await syncProfileCardOnce({ logger, filePath, keyFile, fetch: down.fetch }),
      "failed",
    );
    assert.equal(readFileSync(filePath, "utf8"), before);
  }),
);

test(
  "draft cards titled 「Leo 画像」 are never adopted; a card turned draft counts as gone",
  sandbox(async ({ keyFile, filePath }) => {
    let card1 = card();
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname === "/v1/search")
        return {
          status: 200,
          body: {
            items: [
              // agent 用 brain_save_card 存的草稿:更新,但不能当画像。
              {
                type: "card",
                id: "draft",
                title: PROFILE_CARD_TITLE,
                category: "用户画像",
                status: "draft",
                updated_at: "2026-10-22T12:00:00+08:00",
              },
              {
                type: "card",
                id: "other-cat",
                title: PROFILE_CARD_TITLE,
                category: "个人知识",
                status: "confirmed",
                updated_at: "2026-10-22T12:00:00+08:00",
              },
              {
                type: "card",
                id: "card-1",
                title: PROFILE_CARD_TITLE,
                category: "用户画像",
                status: "confirmed",
                updated_at: "2026-10-22T10:00:00+08:00",
              },
            ],
          },
        };
      if (url.pathname === "/v1/cards") return { status: 200, body: { items: [] } };
      if (url.pathname === "/v1/cards/draft")
        return { status: 200, body: card({ id: "draft", status: "draft" }) };
      if (url.pathname === "/v1/cards/card-1") return { status: 200, body: card1 };
      return { status: 404 };
    });
    assert.equal(await syncProfileCardOnce({ logger, filePath, keyFile, fetch }), "written");
    assert.equal(parseProfileMeta(readFileSync(filePath, "utf8"))!.id, "card-1");
    assert.ok(!calls.some((call) => call.url.pathname === "/v1/cards/draft"));
    // 全文里的状态也要核对:列表没带状态时,取回来是草稿照样不认。
    card1 = card({ status: "draft" });
    assert.equal(await syncProfileCardOnce({ logger, filePath, keyFile, fetch }), "removed");
    assert.equal(existsSync(filePath), false);
  }),
);

test(
  "a newer accepted profile card replaces the pinned one; an older one does not",
  sandbox(async ({ keyFile, filePath }) => {
    let searchItems: unknown[] = [
      {
        type: "card",
        id: "card-1",
        title: PROFILE_CARD_TITLE,
        category: "用户画像",
        status: "confirmed",
        updated_at: "2026-10-22T10:00:00+08:00",
      },
    ];
    const { fetch } = fakeFetch((url) => {
      if (url.pathname === "/v1/search") return { status: 200, body: { items: searchItems } };
      if (url.pathname === "/v1/cards/card-1") return { status: 200, body: card() };
      if (url.pathname === "/v1/cards/card-old")
        return {
          status: 200,
          body: card({ id: "card-old", body: "旧画像", updated_at: "2026-10-01T10:00:00+08:00" }),
        };
      if (url.pathname === "/v1/cards/card-2")
        return {
          status: 200,
          body: card({
            id: "card-2",
            status: "reference",
            body: "换了新手机后的画像",
            version: 1,
            updated_at: "2026-10-22T03:00:00Z",
          }),
        };
      return { status: 404 };
    });
    assert.equal(await syncProfileCardOnce({ logger, filePath, keyFile, fetch }), "written");
    searchItems = [
      {
        type: "card",
        id: "card-old",
        title: PROFILE_CARD_TITLE,
        category: "用户画像",
        status: "confirmed",
        updated_at: "2026-10-01T10:00:00+08:00",
      },
    ];
    assert.equal(await syncProfileCardOnce({ logger, filePath, keyFile, fetch }), "unchanged");
    assert.equal(parseProfileMeta(readFileSync(filePath, "utf8"))!.id, "card-1");
    // 03:00Z = 11:00+08:00,比 card-1 的 10:00+08:00 新(按时间比,不按字符串比)。
    searchItems = [
      {
        type: "card",
        id: "card-2",
        title: PROFILE_CARD_TITLE,
        category: "用户画像",
        status: "reference",
        updated_at: "2026-10-22T03:00:00Z",
      },
    ];
    assert.equal(await syncProfileCardOnce({ logger, filePath, keyFile, fetch }), "written");
    const text = readFileSync(filePath, "utf8");
    assert.equal(parseProfileMeta(text)!.id, "card-2");
    assert.match(text, /换了新手机后的画像/);
  }),
);

test(
  "persistent 401/403 removes the synced profile on the third tick; 5xx and network errors keep it",
  sandbox(async ({ keyFile, filePath }) => {
    const ok = fakeFetch((url) =>
      url.pathname === "/v1/search"
        ? {
            status: 200,
            body: { items: [{ type: "card", id: "card-1", title: PROFILE_CARD_TITLE }] },
          }
        : { status: 200, body: card() },
    );
    const state = { authFailures: 0 };
    await syncProfileCardOnce({ logger, filePath, keyFile, fetch: ok.fetch, state });
    const revoked = fakeFetch(() => ({ status: 401 }));
    const down = fakeFetch(() => ({ status: 503 }));
    const offline: typeof revoked.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const sync = (fetch: typeof revoked.fetch) =>
      syncProfileCardOnce({ logger, filePath, keyFile, fetch, state });
    assert.equal(await sync(revoked.fetch), "failed");
    assert.equal(await sync(revoked.fetch), "failed");
    // 中间成功一次,连续计数清零。
    assert.equal(await sync(ok.fetch), "unchanged");
    assert.equal(await sync(fakeFetch(() => ({ status: 403 })).fetch), "failed");
    assert.equal(await sync(revoked.fetch), "failed");
    assert.equal(await sync(down.fetch), "failed");
    assert.equal(await sync(offline), "failed");
    assert.ok(existsSync(filePath));
    assert.equal(await sync(revoked.fetch), "removed");
    assert.equal(existsSync(filePath), false);
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
    assert.deepEqual(await readBrainStatus({ keyFile, fetch }), {
      enabled: true,
      cards: 1551,
      files: 52037,
    });
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
