import assert from "node:assert/strict";
import test from "node:test";

import {
  createScreenSnapshotService,
  frameEtag,
  type CaptureOptions,
  type CaptureResult,
} from "./snapshot.js";

const iphone = { kind: "iphone" as const, deviceId: "dev-1" };

function setup(
  opts: { enabled?: boolean; frames?: (options: CaptureOptions) => CaptureResult } = {},
) {
  let clock = 1_000_000;
  const calls: CaptureOptions[] = [];
  const handle = createScreenSnapshotService({
    enabled: () => opts.enabled ?? true,
    now: () => clock,
    capture: async (options) => {
      calls.push(options);
      return (
        opts.frames?.(options) ?? {
          ok: true,
          frame: {
            jpeg: Buffer.from("jpeg-bytes"),
            width: 1280,
            height: 800,
            displayId: "1",
            capturedAt: 42,
          },
        }
      );
    },
  });
  return {
    handle,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const req = (
  query = "",
  extra: Partial<Parameters<ReturnType<typeof setup>["handle"]>[0]> = {},
) => ({
  caller: iphone,
  transport: "direct" as const,
  query: new URLSearchParams(query),
  ...extra,
});

test("direct: JPEG body with ETag, then 304 for the same frame via header or query", async () => {
  const { handle, calls } = setup();
  const first = await handle(req("max_edge=640&q=0.5"));
  assert.equal(first.status, 200);
  assert.equal(first.binary?.contentType, "image/jpeg");
  assert.equal(first.binary?.data.toString(), "jpeg-bytes");
  const etag = first.headers?.["etag"];
  assert.equal(etag, frameEtag(Buffer.from("jpeg-bytes")));
  assert.equal(first.headers?.["x-leo-screen-width"], "1280");
  assert.deepEqual(calls[0], { maxEdge: 640, quality: 0.5 });

  const byHeader = await handle(req("", { ifNoneMatch: etag }));
  assert.equal(byHeader.status, 304);
  assert.equal(byHeader.binary, undefined);
  const byQuery = await handle(req(`if_none_match=${encodeURIComponent(etag!)}`));
  assert.equal(byQuery.status, 304);
  const changed = await handle(req("", { ifNoneMatch: '"stale"' }));
  assert.equal(changed.status, 200);
});

test("parameters are clamped; display must be digits", async () => {
  const { handle, calls } = setup();
  await handle(req("max_edge=99999&q=5&display=2"));
  assert.deepEqual(calls[0], { maxEdge: 2560, quality: 0.9, displayId: "2" });
  const bad = await handle(req("display=../x"));
  assert.equal(bad.status, 404);
  assert.equal((bad.body as { error: { code: string } }).error.code, "display_not_found");
});

test("relay: JSON with base64, 1 fps per device, not_modified as 200", async () => {
  const { handle, advance, calls } = setup();
  const first = await handle(req("max_edge=2000", { transport: "relay" }));
  assert.equal(first.status, 200);
  const body = first.body as Record<string, unknown>;
  assert.equal(body["data_base64"], Buffer.from("jpeg-bytes").toString("base64"));
  assert.equal(body["content_type"], "image/jpeg");
  assert.equal(calls[0]?.maxEdge, 1280);

  const tooSoon = await handle(req("", { transport: "relay" }));
  assert.equal(tooSoon.status, 429);
  assert.equal((tooSoon.body as { retry_after_ms: number }).retry_after_ms, 1000);
  advance(400);
  assert.equal(
    ((await handle(req("", { transport: "relay" }))).body as { retry_after_ms: number })
      .retry_after_ms,
    600,
  );
  // 另一台设备不受影响
  assert.equal(
    (await handle(req("", { transport: "relay", caller: { kind: "iphone", deviceId: "dev-2" } })))
      .status,
    200,
  );

  advance(1000);
  const same = await handle(
    req(`if_none_match=${encodeURIComponent(String(body["etag"]))}`, { transport: "relay" }),
  );
  assert.equal(same.status, 200);
  assert.deepEqual(same.body, { etag: body["etag"], not_modified: true });
});

test("relay: frames over 200 KB are re-encoded smaller, and refused if still too big", async () => {
  let shrinkable = true;
  const { handle, calls, advance } = setup({
    frames: (options) => ({
      ok: true,
      frame: {
        jpeg: Buffer.alloc(shrinkable && options.quality < 0.5 ? 150 * 1024 : 300 * 1024),
        width: options.maxEdge,
        height: 600,
        displayId: "1",
        capturedAt: 1,
      },
    }),
  });
  const shrunk = await handle(req("q=0.6", { transport: "relay" }));
  assert.equal(shrunk.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.quality < 0.5 && calls[1]!.maxEdge === 1024);

  shrinkable = false;
  advance(1000);
  calls.length = 0;
  const stillBig = await handle(req("q=0.9", { transport: "relay" }));
  assert.equal(calls.length, 3);
  assert.equal(stillBig.status, 413);
  assert.equal((stillBig.body as { error: { code: string } }).error.code, "frame_too_large");
});

test("switch off, wrong caller kind and missing permission are refused with stable codes", async () => {
  const off = await setup({ enabled: false }).handle(req());
  assert.equal(off.status, 403);
  assert.equal((off.body as { error: { code: string } }).error.code, "screen_disabled");

  const legacy = await setup().handle(req("", { caller: { kind: "legacy", deviceId: "x" } }));
  assert.equal(legacy.status, 403);
  assert.equal((legacy.body as { error: { code: string } }).error.code, "screen_scope_required");
  assert.equal((await setup().handle(req("", { caller: { kind: "unknown" } }))).status, 403);
  assert.equal((await setup().handle(req("", { caller: { kind: "master" } }))).status, 200);
  // 扫直连码配对的手机:legacy + direct- 设备号。
  assert.equal(
    (await setup().handle(req("", { caller: { kind: "legacy", deviceId: "direct-abc" } }))).status,
    200,
  );

  const denied = await setup({
    frames: () => ({
      ok: false,
      status: 428,
      code: "screen_permission",
      message: "没有屏幕录制权限",
    }),
  }).handle(req());
  assert.equal(denied.status, 428);
  assert.equal((denied.body as { error: { code: string } }).error.code, "screen_permission");
});
