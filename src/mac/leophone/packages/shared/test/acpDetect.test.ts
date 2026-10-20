import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loginShellPath,
  parseLoginShellPath,
  resetLoginShellPathCache,
  warmLoginShellPath,
} from "../src/acp-detect.js";

// [leo] 登录 shell 的 PATH 探测不许阻塞主进程 / Host：首次先给快速结果，后台异步探好再进缓存与快照。
function fakeShell(dir: string, delaySeconds: number): string {
  const file = join(dir, "fake-shell.sh");
  writeFileSync(file, `#!/bin/sh\nsleep ${delaySeconds}\nprintf 'hello from rc\\n__LEOPATH__/opt/a:/opt/b__LEOPATH__'\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("login shell PATH", () => {
  afterEach(() => resetLoginShellPathCache());

  it("parses the marked PATH out of noisy rc output", () => {
    expect(parseLoginShellPath("welcome!\n__LEOPATH__/a:/b:__LEOPATH__")).toEqual(["/a", "/b"]);
    expect(parseLoginShellPath("no marker")).toBeUndefined();
  });

  it("returns immediately on first call, then serves the warmed cache and writes a snapshot", async () => {
    const home = mkdtempSync(join(tmpdir(), "leo-acp-"));
    const env = { HOME: home, SHELL: fakeShell(home, 0.4) };
    const started = Date.now();
    expect(loginShellPath(env, { enabled: true })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(200);

    expect(await warmLoginShellPath(env, { enabled: true })).toEqual(["/opt/a", "/opt/b"]);
    expect(loginShellPath(env, { enabled: true })).toEqual(["/opt/a", "/opt/b"]);
    const snapshot = JSON.parse(readFileSync(join(home, ".leophoneagent", "acp", "login-shell-path.json"), "utf8"));
    expect(snapshot.path).toEqual(["/opt/a", "/opt/b"]);

    // 新进程（缓存清空）：直接用上次的快照，不等 shell。
    resetLoginShellPathCache();
    const again = Date.now();
    expect(loginShellPath(env, { enabled: true })).toEqual(["/opt/a", "/opt/b"]);
    expect(Date.now() - again).toBeLessThan(200);
    await warmLoginShellPath(env, { enabled: true });
  });

  it("stays off for injected env unless forced", () => {
    expect(loginShellPath({ HOME: "/nowhere", SHELL: "/bin/false" })).toEqual([]);
  });
});
