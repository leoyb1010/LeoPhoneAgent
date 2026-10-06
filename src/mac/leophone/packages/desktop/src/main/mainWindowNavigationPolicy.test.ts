import assert from "node:assert/strict";
import { test } from "node:test";

import {
  externalUrlForWindowOpen,
  isAllowedExternalOpenUrl,
  isSameAppDocument,
} from "./mainWindowNavigationPolicy.js";

test("main window may only reload its own document with different query/hash", () => {
  const app = "file:///Applications/LeoPhoneAgent.app/Contents/Resources/app.asar/out/renderer/index.html";
  assert.equal(isSameAppDocument(app, `${app}?workspaceMode=server`), true);
  assert.equal(isSameAppDocument("http://localhost:5173/", "http://localhost:5173/?x=1#y"), true);
  assert.equal(isSameAppDocument(app, "file:///Users/me/Downloads/evil.html"), false);
  assert.equal(isSameAppDocument(app, "https://example.com/"), false);
  assert.equal(isSameAppDocument("http://localhost:5173/", "http://localhost:5174/"), false);
  assert.equal(isSameAppDocument(app, "not a url"), false);
});

test("window.open only hands http(s) to the system browser", () => {
  assert.equal(externalUrlForWindowOpen("https://github.com/x"), "https://github.com/x");
  assert.equal(externalUrlForWindowOpen("file:///etc/passwd"), null);
  assert.equal(externalUrlForWindowOpen("javascript:alert(1)"), null);
});

test("webview guests cannot ask the OS to open file: URLs", () => {
  assert.equal(isAllowedExternalOpenUrl("file:///Applications/Calculator.app"), true);
  assert.equal(isAllowedExternalOpenUrl("file:///Applications/Calculator.app", true), false);
  assert.equal(isAllowedExternalOpenUrl("https://example.com", true), true);
  assert.equal(isAllowedExternalOpenUrl("leophoneagent://x"), false);
});
