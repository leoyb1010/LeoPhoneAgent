import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, writeFile, chmod, rm, readdir, symlink, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createNativeProviderLoginRuntime, classifyNativeLoginFailure } from "../services/native-provider-login.js";

async function fixture(extraEnv: NodeJS.ProcessEnv = {}, authorize: () => Promise<void> = async () => {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "native-login-")));
  const root = path.join(base, "homes"); await mkdir(root, { mode: 0o700 });
  const binary = path.join(base, "fake-native-cli");
  await writeFile(binary, `#!/usr/bin/python3
import os, sys, json, signal, time
home = os.environ["CODEX_HOME"]
print("FIXTURE=" + json.dumps({"argv":sys.argv[1:],"ttyIn":os.isatty(0),"ttyOut":os.isatty(1),"home":home,"operatorHome":os.environ.get("HOME"),"apiKey":os.environ.get("OPENAI_API_KEY"),"pid":os.getpid()}), flush=True)
if os.environ.get("FAKE_STALL"):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while True: time.sleep(0.1)
if "setup-token" in sys.argv:
    print("READY_FOR_CODE", flush=True)
    print("CODE=" + sys.stdin.readline().strip(), flush=True)
else:
    fd=os.open(home+"/auth.json", os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
    os.write(fd, b'{"fixture":"native-test-only"}')
    os.close(fd)
`, { mode: 0o700 });
  const runtime = createNativeProviderLoginRuntime({ root, binaries: { codex: binary, grok: binary, claude: binary }, assertAuthorized: authorize, env: { ...process.env, OPENAI_API_KEY: "never-inherit", ...extraEnv } });
  const input = { companyId: "company-one", environmentId: "native-local", startedByUserId: "owner-one", adapterType: "codex_local" as const, sessionId: randomUUID() };
  return { base, root, runtime, input, async close() { await runtime.shutdown(); await rm(base, { recursive: true, force: true }); } };
}
function parsed(output: string) {
  const line = output.split(/[\r\n]+/).find(line => line.startsWith("FIXTURE="));
  expect(line).toBeDefined(); return JSON.parse(line!.slice(8));
}

for (const [type, args] of [["codex_local", ["-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"]], ["grok_local", ["login", "--device-auth"]]] as const) {
  test(`${type}: true PTY, fixed argv, separate home, descriptor credential read and idempotent cleanup`, async () => {
    let authorized = 0; const f = await fixture({}, async () => { authorized++; });
    try {
      const lease = await f.runtime.device.acquireLoginLease({ ...f.input, adapterType: type });
      let output = "";
      expect((await lease.driver.start("UNTRUSTED COMMAND MUST BE IGNORED", data => { output += data; })).exitCode).toBe(0);
      const info = parsed(output);
      expect(info.argv).toEqual(args); expect(info.ttyIn).toBe(true); expect(info.ttyOut).toBe(true);
      expect(info.operatorHome).toBe(process.env.HOME); expect(info.apiKey).toBeNull();
      expect(path.dirname(info.home)).toBe(f.root); expect(authorized).toBe(2);
      expect((await lease.driver.readFile("/untrusted/operator/auth.json")).toString()).toBe('{"fixture":"native-test-only"}');
      await chmod(path.join(info.home, "auth.json"), 0o644);
      await expect(lease.driver.readFile(lease.authPath)).rejects.toThrow();
      await chmod(path.join(info.home, "auth.json"), 0o600);
      await writeFile(path.join(info.home, "auth.json"), Buffer.alloc(65537));
      await expect(lease.driver.readFile(lease.authPath)).rejects.toThrow();
      await rm(path.join(info.home, "auth.json"));
      const outside = path.join(f.base, "operator-auth.json"); await writeFile(outside, "preserved", { mode: 0o600 });
      await symlink(outside, path.join(info.home, "auth.json"));
      await expect(lease.driver.readFile(lease.authPath)).rejects.toThrow();
      await lease.driver.dispose(); await lease.deleteSandbox(); await lease.release();
      expect(await readdir(f.root)).toEqual([]);
      expect(await readFile(outside, "utf8")).toBe("preserved");
    } finally { await f.close(); }
  });
}
test("Claude setup-token uses a private PTY with delayed browser-code input", async () => {
  const f = await fixture();
  try {
    const acquired = await f.runtime.setupToken.acquire({ scope: { companyId: "company-one", environmentId: "native-local", ownerUserId: "owner-one", adapterType: "claude_local" }, deadline: Date.now() + 5000 });
    const session = await acquired.openPtySession("UNTRUSTED COMMAND");
    let output = ""; let submitted = false;
    session.onData(chunk => { output += chunk; if (output.includes("READY_FOR_CODE") && !submitted) { submitted = true; session.write("FIXED-FAKE-CODE\n"); } });
    expect((await session.wait()).exitCode).toBe(0);
    expect(parsed(output).argv).toEqual(["setup-token"]); expect(output).toContain("CODE=FIXED-FAKE-CODE");
    await session.close(); await f.runtime.setupToken.release(acquired.leaseId);
    expect(await readdir(f.root)).toEqual([]);
  } finally { await f.close(); }
});
test("unprivate or aliased root fails before any child or session directory", async () => {
  const f = await fixture();
  try {
    await chmod(f.root, 0o755);
    await expect(f.runtime.device.acquireLoginLease(f.input)).rejects.toThrow();
    expect(await readdir(f.root)).toEqual([]);
    await chmod(f.root, 0o700);
    const alias = path.join(f.base, "aliased-root"); await symlink(f.root, alias);
    const aliased = createNativeProviderLoginRuntime({ root: alias, binaries: { codex: "/usr/bin/false", grok: "/usr/bin/false", claude: "/usr/bin/false" }, assertAuthorized: async () => {} });
    await expect(aliased.device.acquireLoginLease(f.input)).rejects.toThrow();
    expect(await readdir(f.root)).toEqual([]);
    await expect(f.runtime.releaseById("../operator-home")).rejects.toThrow();
  } finally { await f.close(); }
});
test("parent pipe closure stops the terminal child after a server process loss", async () => {
  const f = await fixture();
  try {
    const source = await readFile(new URL("../services/native-provider-login.ts", import.meta.url), "utf8");
    const bridge = source.match(/const SCRIPT_PIPE_BRIDGE = `([\s\S]*?)`;/)?.[1];
    expect(bridge).toBeDefined();
    const child = spawn("/usr/bin/python3", ["-I", "-c", bridge!, String(Date.now() + 5000), path.join(f.base, "fake-native-cli"), "setup-token"], { cwd: f.root, env: { ...process.env, CODEX_HOME: f.root, FAKE_STALL: "1" }, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let output = ""; let closed = false;
    child.stdout.on("data", chunk => { output += chunk.toString(); if (output.includes("FIXTURE=") && !closed) { closed = true; child.stdin.end(); } });
    const done = new Promise(resolve => child.once("close", resolve));
    await done;
    expect(() => process.kill(parsed(output).pid, 0)).toThrow();
  } finally { await f.close(); }
});
test("bridge enforces its deadline without any Node cancellation timer", async () => {
  const f = await fixture();
  try {
    const source = await readFile(new URL("../services/native-provider-login.ts", import.meta.url), "utf8");
    const bridge = source.match(/const SCRIPT_PIPE_BRIDGE = `([\s\S]*?)`;/)?.[1];
    expect(bridge).toBeDefined();
    const started = Date.now();
    const child = spawn("/usr/bin/python3", ["-I", "-c", bridge!, String(started + 400), path.join(f.base, "fake-native-cli"), "setup-token"], { cwd: f.root, env: { ...process.env, CODEX_HOME: f.root, FAKE_STALL: "1" }, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let output = ""; child.stdout.on("data", chunk => { output += chunk.toString(); });
    const fallback = setTimeout(() => child.stdin.end(), 2500);
    try {
      await new Promise(resolve => child.once("close", resolve));
      expect(Date.now() - started).toBeLessThan(2000);
      expect(() => process.kill(parsed(output).pid, 0)).toThrow();
    } finally { clearTimeout(fallback); child.stdin.destroy(); }
  } finally { await f.close(); }
});
test("failed diagnostics emit only fixed categories and whitelisted words", () => {
  const privateText = "https://secret.example/auth?user_code=ABCD-EFGH alice@example.com /private/operator/auth.json PRIVATE_TOKEN_1234567890 ABCD-EFGH unusualPrivateWord";
  for (const [text, category] of [["error HTTP status 429 rate limit", "HTTP_429"], ["error certificate TLS failed", "TLS"], ["error proxy failed", "proxy"], ["error network fetch failed", "network"], ["error permission denied", "permission"], ["error invalid argument", "argument"], ["error tty ioctl failed", "TTY"], ["error no such file directory", "filesystem"], ["error unable request device authorization", "unknown"]]) {
    const result = classifyNativeLoginFailure("grok", 1, `${privateText}\n${text}`);
    expect(result.provider).toBe("grok"); expect(result.exitCode).toBe(1); expect(result.errorCategory).toBe(category);
    expect(result.errorWords).toEqual(text.toLowerCase().match(/[a-z]+/g)?.filter(word => word !== "http"));
    const serialized = JSON.stringify(result);
    for (const secret of ["secret.example", "ABCD", "EFGH", "alice", "operator", "PRIVATE_TOKEN", "unusualPrivateWord"]) expect(serialized).not.toContain(secret);
  }
});
test("cancel and host deadline stop the PTY child even when it ignores TERM", async () => {
  for (const cancel of [true, false]) {
    const f = await fixture({ FAKE_STALL: "1" });
    try {
      const acquired = await f.runtime.setupToken.acquire({ scope: { companyId: "company-one", environmentId: "native-local", ownerUserId: "owner-one", adapterType: "claude_local" }, deadline: Date.now() + (cancel ? 5000 : 400) });
      const session = await acquired.openPtySession("ignored");
      let output = ""; session.onData(chunk => { output += chunk; if (cancel && output.includes("FIXTURE=")) session.kill(); });
      await session.wait(); await session.close();
      const pid = parsed(output).pid;
      expect(() => process.kill(pid, 0)).toThrow();
      await f.runtime.setupToken.release(acquired.leaseId);
      expect(await readdir(f.root)).toEqual([]);
    } finally { await f.close(); }
  }
});
test("authorization denial and unsupported adapters create no session home", async () => {
  const f = await fixture({}, async () => { throw new Error("denied"); });
  try {
    await expect(f.runtime.device.acquireLoginLease(f.input)).rejects.toThrow("denied");
    await expect(f.runtime.device.acquireLoginLease({ ...f.input, adapterType: "claude_local" })).rejects.toThrow();
    expect(await readdir(f.root)).toEqual([]);
  } finally { await f.close(); }
});
test("recheck authorization before spawning and fence expired orphan deletion", async () => {
  let authorized = 0; const f = await fixture({}, async () => { if (++authorized > 1) throw new Error("revoked"); });
  try {
    const lease = await f.runtime.device.acquireLoginLease(f.input);
    await expect(lease.driver.start("ignored", () => {})).rejects.toThrow("revoked");
    await f.runtime.reapExpired(async () => false, Date.now() + 10 * 60 * 1000);
    expect(await readdir(f.root)).toHaveLength(1);
    await f.runtime.reapExpired(async record => record.companyId === f.input.companyId && record.startedByUserId === f.input.startedByUserId, Date.now() + 10 * 60 * 1000);
    expect(await readdir(f.root)).toEqual([]);
  } finally { await f.close(); }
});
