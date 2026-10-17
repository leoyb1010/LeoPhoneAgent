import assert from "node:assert/strict";
import test from "node:test";

import {
  acceleratorFromKeyEvent,
  formatAccelerator,
  isAcceleratorRelease,
} from "../src/leo/quickEntryAccelerator.js";

const press = (
  code: string,
  mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
) => ({
  code,
  key: "≈",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

test("uses the physical key so ⌥ combinations are not read as ≈ / ¬", () => {
  assert.equal(acceleratorFromKeyEvent(press("Space", { altKey: true })), "Alt+Space");
  assert.equal(
    acceleratorFromKeyEvent(press("KeyL", { ctrlKey: true, altKey: true })),
    "Control+Alt+L",
  );
  assert.equal(
    acceleratorFromKeyEvent(press("Digit1", { metaKey: true, shiftKey: true })),
    "Command+Shift+1",
  );
  assert.equal(acceleratorFromKeyEvent(press("F5")), "F5");
  assert.equal(acceleratorFromKeyEvent(press("Slash", { ctrlKey: true })), "Control+/");
});

test("modifier-only presses keep waiting", () => {
  assert.equal(acceleratorFromKeyEvent(press("AltLeft", { altKey: true })), null);
  assert.equal(acceleratorFromKeyEvent(press("MetaRight", { metaKey: true })), null);
});

test("labels use macOS symbols", () => {
  assert.equal(formatAccelerator("Alt+Space"), "⌥Space");
  assert.equal(formatAccelerator("Command+Control+Alt+Shift+Up"), "⌘⌃⌥⇧↑");
});

test("push-to-talk ends when the main key or any required modifier is released", () => {
  assert.equal(isAcceleratorRelease({ code: "Backquote", key: "Dead" }, "Alt+`"), true);
  assert.equal(isAcceleratorRelease({ code: "AltLeft", key: "Alt" }, "Alt+`"), true);
  assert.equal(isAcceleratorRelease({ code: "ShiftLeft", key: "Shift" }, "Alt+`"), false);
  assert.equal(isAcceleratorRelease({ code: "KeyV", key: "v" }, "Control+Alt+V"), true);
  assert.equal(
    isAcceleratorRelease({ code: "ControlLeft", key: "Control" }, "Control+Alt+V"),
    true,
  );
  assert.equal(isAcceleratorRelease({ code: "KeyB", key: "b" }, "Control+Alt+V"), false);
  assert.equal(isAcceleratorRelease({ code: "F5", key: "F5" }, "F5"), true);
});
