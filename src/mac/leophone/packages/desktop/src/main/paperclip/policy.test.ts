import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalPaperclipOrigin,
  validatePaperclipRequest,
  validatePaperclipDownload,
  publicPaperclipSession,
  safeDownloadFilename,
  matchesPaperclipRenderer,
} from "./policy.js";

test("canonical origins isolate servers and prohibit insecure remote credentials", () => {
  assert.equal(canonicalPaperclipOrigin("https://EXAMPLE.com:443/"), "https://example.com");
  assert.equal(canonicalPaperclipOrigin("http://127.0.0.1:3100"), "http://127.0.0.1:3100");
  for (const input of [
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com/api",
    "https://example.com?q=secret",
    "https://example.com/#token",
    "file:///tmp",
  ])
    assert.throws(() => canonicalPaperclipOrigin(input));
});

test("only bounded upstream methods and paths pass IPC", () => {
  const serverUrl = "https://example.com";
  assert.match(
    validatePaperclipRequest({
      serverUrl,
      method: "GET",
      path: "/api/companies/c1/issues?limit=100",
    }).url,
    /limit=100$/,
  );
  assert.doesNotThrow(() =>
    validatePaperclipRequest({
      serverUrl,
      method: "POST",
      path: "/api/heartbeat-runs/r1/cancel",
      body: {},
      expectedUserId: "u1",
    }),
  );
  for (const path of [
    "//evil.com/api/companies",
    "/api/../secrets",
    "/api/%2e%2e/secrets",
    "/api/companies#oops",
    "/api/auth/sign-in/email",
    "/api/agents/a1/keys",
    "/api/issues/i1\\comments",
  ]) {
    assert.throws(() => validatePaperclipRequest({ serverUrl, method: "POST", path }));
  }
  assert.throws(() =>
    validatePaperclipRequest({ serverUrl, method: "DELETE", path: "/api/issues/i1" }),
  );
  assert.throws(() =>
    validatePaperclipRequest({ serverUrl, method: "GET", path: "/api/companies", body: {} }),
  );
});

test("session return cannot disclose credentials", () => {
  const value = publicPaperclipSession({
    user: { id: "u1", name: "甲", password: "hidden" },
    session: { token: "secret", expiresAt: "soon" },
    accessToken: "secret",
  });
  assert.deepEqual(value, {
    user: { id: "u1", name: "甲", email: null },
    session: { expiresAt: "soon" },
  });
  assert.equal(publicPaperclipSession({ token: "secret" }), null);
  assert.deepEqual(publicPaperclipSession({ data: { user: { id: "u1" } } }), {
    user: { id: "u1", name: null, email: null },
    session: { expiresAt: null },
  });
});

test("download paths and filenames cannot redirect or traverse", () => {
  assert.equal(
    validatePaperclipDownload("https://example.com", "/api/attachments/a1/content?download=1"),
    "https://example.com/api/attachments/a1/content?download=1",
  );
  for (const path of [
    "https://evil.com/file",
    "/api/attachments/a1/content?url=evil",
    "/api/attachments/../content",
    "/api/assets/a1/content#secret",
  ])
    assert.throws(() => validatePaperclipDownload("https://example.com", path));
  assert.equal(safeDownloadFilename("../../秘密.txt"), "_.._秘密.txt");
});

test("auth query cannot bypass token stripping and renderer grants bind exact entrypoint", () => {
  assert.throws(() =>
    validatePaperclipRequest({
      serverUrl: "https://example.com",
      method: "GET",
      path: "/api/auth/get-session?x=1",
    }),
  );
  assert.equal(
    matchesPaperclipRenderer("http://localhost:5173/?launch=1", "http://localhost:5173/"),
    true,
  );
  assert.equal(matchesPaperclipRenderer("http://localhost:5174/", "http://localhost:5173/"), false);
  assert.equal(
    matchesPaperclipRenderer("file:///app/renderer/other.html", "file:///app/renderer/index.html"),
    false,
  );
});

test("all writes require the task-bound human identity", () => {
  assert.throws(
    () =>
      validatePaperclipRequest({
        serverUrl: "https://example.com",
        method: "POST",
        path: "/api/issues/i1/comments",
        body: { body: "hello" },
      }),
    /操作者/,
  );
});
