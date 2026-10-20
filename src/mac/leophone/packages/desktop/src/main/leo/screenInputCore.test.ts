import assert from "node:assert/strict";
import test from "node:test";

import { CONTROL_COOLDOWN_MS, createControlCooldown, MAX_TEXT_CHARS, parseInputEvent } from "./screenInputCore.js";

test("mouse events: coordinates clamped to 0–1, bad shapes rejected", () => {
  assert.deepEqual(parseInputEvent('{"t":"move","x":0.25,"y":1.7}'), { t: "move", x: 0.25, y: 1 });
  assert.equal(parseInputEvent('{"t":"move","x":"a","y":0}'), null);
  assert.deepEqual(parseInputEvent('{"t":"down","b":"right","x":0,"y":0}'), {
    t: "down",
    b: "right",
    x: 0,
    y: 0,
  });
  assert.deepEqual(parseInputEvent('{"t":"up"}'), { t: "up", b: "left" });
  assert.equal(parseInputEvent('{"t":"up","x":0.5}'), null);
  assert.deepEqual(parseInputEvent('{"t":"click","n":2,"b":"weird","x":0.1,"y":0.2,"extra":1}'), {
    t: "click",
    b: "left",
    n: 2,
    x: 0.1,
    y: 0.2,
  });
  assert.deepEqual(parseInputEvent('{"t":"scroll","dy":99999,"dx":-3.6}'), {
    t: "scroll",
    dx: -4,
    dy: 5000,
  });
});

test("keys: only known W3C codes and modifiers; default phase is press", () => {
  assert.deepEqual(parseInputEvent('{"t":"key","code":"KeyC","mods":["cmd","cmd","hyper"]}'), {
    t: "key",
    code: "KeyC",
    mods: ["cmd"],
    phase: "press",
  });
  assert.deepEqual(parseInputEvent('{"t":"key","code":"ArrowLeft","phase":"down"}'), {
    t: "key",
    code: "ArrowLeft",
    mods: [],
    phase: "down",
  });
  assert.equal(parseInputEvent('{"t":"key","code":"Power"}'), null);
  assert.ok(parseInputEvent('{"t":"key","code":"F12"}'));
  assert.equal(parseInputEvent('{"t":"key","code":"F18"}'), null);
});

test("text: control characters dropped, length capped; garbage is null", () => {
  assert.deepEqual(parseInputEvent(JSON.stringify({ t: "text", s: "你好\u0007\nok👍" })), {
    t: "text",
    s: "你好\nok👍",
  });
  const long = parseInputEvent(JSON.stringify({ t: "text", s: "字".repeat(MAX_TEXT_CHARS + 10) }));
  assert.equal(long?.t === "text" && [...long.s].length, MAX_TEXT_CHARS);
  for (const bad of [
    "",
    "null",
    "[]",
    '{"t":"text","s":""}',
    '{"t":"exec","cmd":"rm"}',
    "x".repeat(20_000),
  ])
    assert.equal(parseInputEvent(bad), null, bad.slice(0, 20));
});

test("control cooldown: 10 s after a local disconnect, then control is allowed again", () => {
  let now = 1_000;
  const cooldown = createControlCooldown(CONTROL_COOLDOWN_MS, () => now);
  assert.equal(cooldown.remaining(), 0);
  cooldown.start();
  assert.equal(cooldown.remaining(), 10_000);
  now += 9_000;
  assert.equal(cooldown.remaining(), 1_000);
  now += 1_000;
  assert.equal(cooldown.remaining(), 0);
});
