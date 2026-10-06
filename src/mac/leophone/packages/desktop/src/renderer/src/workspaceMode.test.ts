import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORKSPACE_MODE_STORAGE_KEY,
  prepareWorkspaceModeSwitch,
  resolveWorkspaceMode,
} from "./workspaceMode.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

test("first run defaults to the local workspace", () => {
  assert.equal(resolveWorkspaceMode(null, memoryStorage()), "local");
  assert.equal(resolveWorkspaceMode(null, null), "local");
  assert.equal(
    resolveWorkspaceMode(null, memoryStorage({ [WORKSPACE_MODE_STORAGE_KEY]: "bogus" })),
    "local",
  );
});

test("remembers the last chosen mode", () => {
  const storage = memoryStorage();
  prepareWorkspaceModeSwitch("server", "file:///app/index.html", storage);
  assert.equal(resolveWorkspaceMode(null, storage), "server");
  prepareWorkspaceModeSwitch("local", "file:///app/index.html", storage);
  assert.equal(resolveWorkspaceMode(null, storage), "local");
});

test("explicit URL override wins; legacy local-recovery means local", () => {
  const server = memoryStorage({ [WORKSPACE_MODE_STORAGE_KEY]: "server" });
  assert.equal(resolveWorkspaceMode("local-recovery", server), "local");
  assert.equal(resolveWorkspaceMode("local", server), "local");
  assert.equal(resolveWorkspaceMode("server", memoryStorage()), "server");
});

test("switching clears the override param and keeps other flags", () => {
  const href = prepareWorkspaceModeSwitch(
    "local",
    "file:///app/index.html?restoreSession=true&workspaceMode=server",
    memoryStorage(),
  );
  assert.equal(href, "file:///app/index.html?restoreSession=true");
});

test("switching still works when storage throws", () => {
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(resolveWorkspaceMode(null, broken), "local");
  const href = prepareWorkspaceModeSwitch("server", "file:///app/index.html", broken);
  assert.equal(
    resolveWorkspaceMode(new URL(href).searchParams.get("workspaceMode"), broken),
    "server",
  );
});
