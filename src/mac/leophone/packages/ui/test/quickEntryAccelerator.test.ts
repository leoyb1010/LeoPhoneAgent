import assert from "node:assert/strict";
import test from "node:test";

import { acceleratorFromKeyEvent, formatAccelerator } from "../src/leo/quickEntryAccelerator.js";

const press = (code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
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
  assert.equal(acceleratorFromKeyEvent(press("KeyL", { ctrlKey: true, altKey: true })), "Control+Alt+L");
  assert.equal(acceleratorFromKeyEvent(press("Digit1", { metaKey: true, shiftKey: true })), "Command+Shift+1");
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
