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

test("IPC route whitelist matches exactly the routes the paperclip service calls", () => {
  const serverUrl = "https://example.com";
  const allow = (method: "GET" | "POST" | "PATCH", path: string) =>
    validatePaperclipRequest({
      serverUrl,
      method,
      path,
      ...(method === "GET" ? {} : { body: {}, expectedUserId: "u1" }),
    });
  // 与 services/src/paperclip/app 中 api()/requestPaperclip 的实际调用一一对应。
  const used: Array<["GET" | "POST" | "PATCH", string]> = [
    ["GET", "/api/health"],
    ["GET", "/api/auth/get-session"],
    ["GET", "/api/companies?scope=accessible"],
    ["GET", "/api/companies/c1/issues?limit=100&offset=0"],
    ["GET", "/api/companies/c1/agents"],
    ["GET", "/api/issues/i1"],
    ["GET", "/api/issues/i1/comments?order=asc"],
    ["GET", "/api/issues/i1/runs"],
    ["GET", "/api/issues/i1/approvals"],
    ["GET", "/api/issues/i1/attachments"],
    ["GET", "/api/heartbeat-runs/r1"],
    ["GET", "/api/heartbeat-runs/r1/log?offset=0&limitBytes=64000"],
    ["GET", "/api/approvals/a1"],
    ["POST", "/api/companies/c1/issues"],
    ["POST", "/api/issues/i1/comments"],
    ["POST", "/api/heartbeat-runs/r1/cancel"],
    ["POST", "/api/approvals/a1/approve"],
    ["POST", "/api/approvals/a1/reject"],
    ["PATCH", "/api/issues/i1"],
  ];
  for (const [method, path] of used) assert.doesNotThrow(() => allow(method, path), path);
  // 旧白名单开放但服务层从未调用的路由必须被拒绝。
  const unused: Array<["GET" | "POST" | "PATCH", string]> = [
    ["GET", "/api/companies/c1/approvals"],
    ["GET", "/api/companies/c1/heartbeat-runs"],
    ["GET", "/api/companies/c1/live-runs"],
    ["GET", "/api/issues/i1/live-runs"],
    ["GET", "/api/issues/i1/active-run"],
    ["GET", "/api/issues/i1/execution"],
    ["GET", "/api/issues/i1/documents"],
    ["GET", "/api/issues/i1/work-products"],
    ["GET", "/api/issues/i1/documents/d1"],
    ["GET", "/api/heartbeat-runs/r1/events"],
    ["GET", "/api/approvals/a1/comments"],
    ["GET", "/api/approvals/a1/issues"],
    ["POST", "/api/issues/i1"],
    ["PATCH", "/api/companies/c1/issues"],
  ];
  for (const [method, path] of unused) assert.throws(() => allow(method, path), /尚未开放/, path);
});
