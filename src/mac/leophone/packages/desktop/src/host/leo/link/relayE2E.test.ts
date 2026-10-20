import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deriveKeys,
  loadRelayE2EKey,
  privateKeyFromRaw,
  rawPublicKey,
  RelayE2E,
  sealRequest,
  sealResponse,
  unseal,
} from "./relayE2E.js";

// 跨端向量:iOS MinisTests/RelayE2ETests.swift 写死了同一组输入与输出,两边任何一处改了线格式这里都会红。
const VECTOR = {
  macPrivate: Buffer.alloc(32, 1),
  ephemeralPrivate: Buffer.alloc(32, 2),
  macPublic: "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk",
  ephemeralPublic: "zo060cy2M-x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk",
  request: '{"method":"GET","path":"/health"}',
  requestSealed: "jB7nKhyYdOR2vLbrsAbGy_GqLMjxQvMpER-DW9fyMvCgO1oo0UPWI_EY8Yl8WbXCZQ",
  response: '{"status":200,"body":{"ok":true}}',
  responseSealed: "jIS0IQWX_Zbx7nXKKNGLyy-mePuGESi9tcMqjK69ZNCv4A6lMLBu0NdGlw9CEufyRQ",
  frame1: "hello",
  frame1Sealed: "fZrUWM84_raPXFTHcRfUbQv-lG5z",
};

test("cross-platform vector matches iOS byte for byte", () => {
  const mac = privateKeyFromRaw(VECTOR.macPrivate);
  const eph = privateKeyFromRaw(VECTOR.ephemeralPrivate);
  const macPub = rawPublicKey(mac);
  const ephPub = rawPublicKey(eph);
  assert.equal(macPub.toString("base64url"), VECTOR.macPublic);
  assert.equal(ephPub.toString("base64url"), VECTOR.ephemeralPublic);
  const phone = deriveKeys(eph, macPub, ephPub, macPub);
  const desk = deriveKeys(mac, ephPub, ephPub, macPub);
  assert.deepEqual(phone, desk);
  assert.equal(sealRequest(phone, Buffer.from(VECTOR.request)), VECTOR.requestSealed);
  assert.equal(sealResponse(phone, 0, Buffer.from(VECTOR.response)), VECTOR.responseSealed);
  assert.equal(sealResponse(phone, 1, Buffer.from(VECTOR.frame1)), VECTOR.frame1Sealed);
});

/** 模拟手机:现生成临时钥匙,封一个内层请求。 */
function phoneEnvelope(macPublic: Buffer, inner: Record<string, unknown>) {
  const { privateKey } = generateKeyPairSync("x25519");
  const ephPub = rawPublicKey(privateKey);
  const keys = deriveKeys(privateKey, macPublic, ephPub, macPublic);
  const envelope = { v: 1, k: ephPub.toString("base64url"), c: sealRequest(keys, Buffer.from(JSON.stringify(inner))) };
  return { keys, envelope };
}

test("handle decrypts, routes the inner request and seals the reply; replay and tamper are refused", async () => {
  const e2e = new RelayE2E(privateKeyFromRaw(Buffer.alloc(32, 7)));
  const { keys, envelope } = phoneEnvelope(e2e.publicKey, {
    method: "post",
    path: "/harness/sessions/s1/send",
    body: { text: "机密" },
    request_id: "req-1",
  });
  const seen: unknown[] = [];
  const result = await e2e.handle(envelope, async (inner) => {
    seen.push(inner);
    return { status: 202, body: { ok: true } };
  });
  assert.deepEqual(seen, [{ method: "POST", path: "/harness/sessions/s1/send", body: { text: "机密" }, requestId: "req-1" }]);
  // 外层状态码照抄内层(中继排队回执靠它判断 Mac 拒没拒),正文只有密文。
  assert.equal(result.status, 202);
  const body = result.body as { v: number; c: string };
  assert.equal(body.v, 1);
  assert.ok(!JSON.stringify(body).includes("ok"));
  assert.deepEqual(JSON.parse(unseal(keys.resp, 0, body.c, Buffer.from("leobot-e2e-resp")).toString()), {
    status: 202,
    body: { ok: true },
  });

  const replay = await e2e.handle(envelope, async () => assert.fail("replay must not run"));
  assert.equal(replay.status, 409);
  assert.equal((replay.body as { error: { code: string } }).error.code, "e2e_replay");

  const fresh = phoneEnvelope(e2e.publicKey, { method: "GET", path: "/health" }).envelope;
  const flipped = { ...fresh, c: fresh.c.slice(0, -2) + (fresh.c.endsWith("A") ? "BB" : "AA") };
  const tampered = await e2e.handle(flipped, async () => assert.fail("tampered must not run"));
  assert.equal(tampered.status, 400);
  assert.equal((tampered.body as { error: { code: string } }).error.code, "e2e_rejected");

  // 用别的 Mac 公钥封的(手机固定的是旧钥匙):解不开,手机据 e2e_rejected 退回明文。
  const other = rawPublicKey(generateKeyPairSync("x25519").privateKey);
  const wrongKey = await e2e.handle(phoneEnvelope(other, { method: "GET", path: "/health" }).envelope, async () =>
    assert.fail("wrong key must not run"),
  );
  assert.equal(wrongKey.status, 400);

  const nested = await e2e.handle(phoneEnvelope(e2e.publicKey, { method: "POST", path: "/e2e" }).envelope, async () =>
    assert.fail("nesting must not run"),
  );
  assert.equal(nested.status, 400);
});

test("stream opens with frame 0 and seals each event with the next counter", async () => {
  const e2e = new RelayE2E(privateKeyFromRaw(Buffer.alloc(32, 9)));
  const { keys, envelope } = phoneEnvelope(e2e.publicKey, {
    method: "GET",
    path: "/harness/sessions/s1/events?after=3",
  });
  const query = new URLSearchParams({ v: "1", k: envelope.k, c: envelope.c });
  const frames: string[] = [];
  let innerPath = "";
  await e2e.stream(
    query,
    async (inner, write) => {
      innerPath = inner.path;
      write('{"event":"message.delta","delta":"秘密","seq":4}');
      write('{"event":"run.completed","seq":5}');
    },
    (data) => frames.push(data),
  );
  assert.equal(innerPath, "/harness/sessions/s1/events?after=3");
  const plain = frames.map((frame, n) =>
    unseal(keys.resp, n, (JSON.parse(frame) as { c: string }).c, Buffer.from("leobot-e2e-resp")).toString(),
  );
  assert.deepEqual(plain, [
    '{"type":"e2e.open"}',
    '{"event":"message.delta","delta":"秘密","seq":4}',
    '{"event":"run.completed","seq":5}',
  ]);
  assert.ok(frames.every((frame) => !frame.includes("message.delta")));
  // 中继丢一帧 / 换顺序:手机按计数解,解不开。
  assert.throws(() => unseal(keys.resp, 1, (JSON.parse(frames[2]!) as { c: string }).c, Buffer.from("leobot-e2e-resp")));

  // 重放同一个流请求:一帧都不发(手机没等到第 0 帧就退回明文)。
  const again: string[] = [];
  await e2e.stream(query, async () => assert.fail("replayed stream must not open"), (data) => again.push(data));
  assert.deepEqual(again, []);
});

test("key file is created 0600 once and reused; a corrupt file is not silently replaced", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-e2e-"));
  try {
    const file = path.join(dir, "link", "relay-e2e-key.json");
    const [a, b] = await Promise.all([loadRelayE2EKey(file), loadRelayE2EKey(file)]);
    assert.deepEqual(rawPublicKey(a), rawPublicKey(b));
    assert.deepEqual(rawPublicKey(await loadRelayE2EKey(file)), rawPublicKey(a));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(file, "utf8")).v, 1);
    await writeFile(file, "{}");
    await assert.rejects(loadRelayE2EKey(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bridge: /e2e reaches the normal route table; a Mac without e2e answers 404 so the phone falls back", async () => {
  const { LinkBridge } = await import("./bridge.js");
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-e2e-bridge-"));
  const e2e = new RelayE2E(privateKeyFromRaw(Buffer.alloc(32, 5)));
  const deps = {
    taskService: {} as never,
    logger: { info() {}, warn() {} },
    push() {},
    appVersion: "test",
    journalDir: path.join(dir, "journals"),
    leoagent: { url: "http://127.0.0.1:2", key: () => null },
    sshHostKeys: async () => [],
  };
  const caller = { kind: "iphone" as const, deviceId: "dev-1" };
  try {
    const bridge = new LinkBridge({ ...deps, e2e });
    const call = async (inner: Record<string, unknown>) => {
      const { keys, envelope } = phoneEnvelope(e2e.publicKey, inner);
      const res = await bridge.handle({ method: "POST", path: "/e2e", body: envelope, caller });
      const sealed = (res.body as { c?: string }).c;
      return { outer: res.status, inner: sealed ? JSON.parse(unseal(keys.resp, 0, sealed, Buffer.from("leobot-e2e-resp")).toString()) : null };
    };
    const health = await call({ method: "GET", path: "/health" });
    assert.equal(health.outer, 200);
    assert.equal(health.inner.body.platform, "leoagent");
    // 白名单照旧作用在内层:模型代理经加密通道也进不来。
    assert.deepEqual((await call({ method: "GET", path: "/v1/models" })).inner.status, 404);
    const caps = await call({ method: "GET", path: "/v1/capabilities" });
    assert.equal(caps.inner.body.relay_e2e.public_key, e2e.publicKeyText);
    assert.equal(caps.inner.body.features.relay_e2e, true);

    const frames: string[] = [];
    const { keys, envelope } = phoneEnvelope(e2e.publicKey, { method: "GET", path: "/harness/sessions/missing/events" });
    await bridge.stream(
      { method: "GET", path: `/e2e/events?${new URLSearchParams({ v: "1", k: envelope.k, c: envelope.c })}`, caller },
      (data) => frames.push(data),
      new AbortController().signal,
    );
    assert.equal(frames.length, 1);
    assert.equal(unseal(keys.resp, 0, JSON.parse(frames[0]!).c, Buffer.from("leobot-e2e-resp")).toString(), '{"type":"e2e.open"}');

    const old = new LinkBridge(deps);
    const legacy = await old.handle({ method: "POST", path: "/e2e", body: phoneEnvelope(e2e.publicKey, { method: "GET", path: "/health" }).envelope, caller });
    assert.equal(legacy.status, 404);
    const none: string[] = [];
    await old.stream({ method: "GET", path: "/e2e/events?v=1", caller }, (data) => none.push(data), new AbortController().signal);
    assert.deepEqual(none, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
