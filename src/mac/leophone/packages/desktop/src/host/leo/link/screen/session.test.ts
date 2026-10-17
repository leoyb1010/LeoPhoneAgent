import assert from "node:assert/strict";
import test from "node:test";

import type { Caller } from "../session.js";
import type { ScreenSettings } from "./hostCapture.js";
import { createScreenSessionService, mayControlScreen } from "./session.js";

const PHONE: Caller = { kind: "iphone", deviceId: "phone-a" } as Caller;
const PAD: Caller = { kind: "iphone", deviceId: "pad-b" } as Caller;
const LEGACY: Caller = { kind: "legacy", deviceId: "old" } as Caller;

const ANSWER = [
  "v=0",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host",
  "a=candidate:2 1 udp 2122194687 100.90.1.2 50001 typ host",
  "",
].join("\r\n");

function harness(overrides: Partial<ScreenSettings> = {}) {
  const settings: ScreenSettings = {
    enabled: true,
    tailnetOnly: false,
    control: false,
    ...overrides,
  };
  const calls: Record<string, unknown>[] = [];
  const live = new Set<string>();
  let counter = 0;
  const service = createScreenSessionService({
    settings: async () => settings,
    turnConfig: async () => ({ urls: ["turn:mini.example:3478"], secret: "0123456789abcdef0123" }),
    now: () => 1_000_000,
    newId: () => `scr_00000000-0000-0000-0000-00000000000${counter++}`,
    resolve: async () => null,
    peer: async (payload) => {
      calls.push(payload);
      switch (payload["op"]) {
        case "status":
          return { status: 200, body: { sessions: [...live].map((id) => ({ id })) } };
        case "open":
          live.clear();
          live.add(String(payload["sessionId"]));
          return { status: 200, body: { answer: ANSWER } };
        case "close":
          live.delete(String(payload["sessionId"]));
          return { status: 200, body: { ok: true } };
        case "ice":
          return { status: 200, body: { ok: true } };
        default:
          return { status: 200, body: { state: "connected", encoder: "VideoToolbox" } };
      }
    },
  });
  return { service, settings, calls, live };
}

const offer = "v=0\r\na=candidate:1 1 udp 1 192.168.1.5 6000 typ host\r\n";
const body = (value: unknown) => value as Record<string, unknown>;

test("open → answer with tailnet first, TURN creds, then ice / stats / delete", async () => {
  const { service, calls } = harness();
  const opened = await service({
    method: "POST",
    subpath: "",
    caller: PHONE,
    body: { offer, max_fps: 99, max_edge: 10 },
  });
  assert.equal(opened.status, 200);
  const result = body(opened.body);
  const id = String(result["session_id"]);
  assert.match(id, /^scr_/);
  assert.deepEqual(result["candidate_tiers"], ["tailnet", "lan"]);
  assert.equal(result["control"], false);
  assert.equal((result["ice_servers"] as unknown[]).length, 1);
  assert.equal(result["expires_at"], 1_030_000);
  const open = calls.find((call) => call["op"] === "open")!;
  assert.equal(open["maxFps"], 60);
  assert.equal(open["maxEdge"], 640);

  const ice = await service({
    method: "POST",
    subpath: `/${id}/ice`,
    caller: PHONE,
    body: {
      candidates: [
        { candidate: "candidate:1 1 udp 1 10.0.0.2 7000 typ host", sdpMid: "0" },
        { bad: 1 },
      ],
    },
  });
  assert.deepEqual(ice.body, { ok: true, accepted: 1, dropped: 1 });
  const stats = await service({ method: "GET", subpath: `/${id}`, caller: PHONE, body: undefined });
  assert.equal(body(stats.body)["encoder"], "VideoToolbox");
  // 别的设备看不到这个会话。
  const foreign = await service({
    method: "DELETE",
    subpath: `/${id}`,
    caller: PAD,
    body: undefined,
  });
  assert.equal(foreign.status, 404);
  const closed = await service({
    method: "DELETE",
    subpath: `/${id}`,
    caller: PHONE,
    body: undefined,
  });
  assert.equal(closed.status, 200);
  const gone = await service({ method: "GET", subpath: `/${id}`, caller: PHONE, body: undefined });
  assert.equal(gone.status, 404);
});

test("one viewer at a time: other device gets 409, same device replaces", async () => {
  const { service } = harness();
  const first = await service({ method: "POST", subpath: "", caller: PHONE, body: { offer } });
  assert.equal(first.status, 200);
  const other = await service({ method: "POST", subpath: "", caller: PAD, body: { offer } });
  assert.equal(other.status, 409);
  assert.equal(body(body(other.body)["error"])["code"], "session_limit");
  const again = await service({ method: "POST", subpath: "", caller: PHONE, body: { offer } });
  assert.equal(again.status, 200);
  assert.notEqual(body(again.body)["session_id"], body(first.body)["session_id"]);
});

test("a session the Mac already dropped frees the slot", async () => {
  const { service, live } = harness();
  await service({ method: "POST", subpath: "", caller: PHONE, body: { offer } });
  live.clear();
  const other = await service({ method: "POST", subpath: "", caller: PAD, body: { offer } });
  assert.equal(other.status, 200);
});

test("switch, scope, bad input, tailnet-only and control are enforced", async () => {
  assert.equal(
    (
      await harness({ enabled: false }).service({
        method: "POST",
        subpath: "",
        caller: PHONE,
        body: { offer },
      })
    ).status,
    403,
  );
  assert.equal(
    (await harness().service({ method: "POST", subpath: "", caller: LEGACY, body: { offer } }))
      .status,
    403,
  );
  assert.equal(
    (
      await harness().service({
        method: "POST",
        subpath: "",
        caller: PHONE,
        body: { offer: "nope" },
      })
    ).status,
    400,
  );
  assert.equal(
    (await harness().service({ method: "PUT", subpath: "", caller: PHONE, body: undefined }))
      .status,
    405,
  );
  const preflight = await harness({ control: true }).service({
    method: "GET",
    subpath: "",
    caller: PHONE,
    body: undefined,
  });
  assert.equal(preflight.status, 200);
  assert.equal(body(preflight.body)["control"], true);
  assert.equal((body(preflight.body)["ice_servers"] as unknown[]).length, 1);

  const tailnet = harness({ tailnetOnly: true });
  const opened = await tailnet.service({
    method: "POST",
    subpath: "",
    caller: PHONE,
    body: { offer },
  });
  assert.deepEqual(body(opened.body)["candidate_tiers"], ["tailnet"]);
  assert.deepEqual(body(opened.body)["ice_servers"], []);
  // offer 里的局域网候选在交给主进程前就去掉了。
  assert.ok(
    !String(tailnet.calls.find((call) => call["op"] === "open")!["offer"]).includes("192.168.1.5"),
  );

  const asked = await harness().service({
    method: "POST",
    subpath: "",
    caller: PHONE,
    body: { offer, control: true },
  });
  assert.equal(body(asked.body)["control"], false);
  const allowed = await harness({ control: true }).service({
    method: "POST",
    subpath: "",
    caller: PHONE,
    body: { offer, control: true },
  });
  assert.equal(body(allowed.body)["control"], true);
  assert.equal(
    mayControlScreen(LEGACY, { enabled: true, tailnetOnly: false, control: true }),
    false,
  );
});
