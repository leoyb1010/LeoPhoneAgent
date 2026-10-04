import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LoginPtySession, LoginPtySessionOpener } from "@paperclipai/adapter-utils/login-pty-transport";
import { createLoginPtyTransport } from "@paperclipai/adapter-utils/login-pty-transport";
import type { AcquireLoginLeaseInput, LoginSessionRuntime } from "./device-login-service.js";
import type { SetupTokenSandboxProvider } from "./setup-token-transport-binding.js";
import { readLocalAiCredentialFile } from "./local-ai-credential-file.js";

type LoginKey = "codex" | "grok" | "claude";
export interface NativeProviderLoginFailure {
  provider: LoginKey;
  exitCode: number;
  errorCategory: string;
  errorWords: string[];
}
const FAILURE_WORDS = new Set(["error", "failed", "unable", "cannot", "network", "fetch", "request", "response", "status", "timeout", "certificate", "tls", "ssl", "proxy", "connect", "connection", "permission", "denied", "argument", "option", "unknown", "invalid", "terminal", "tty", "ioctl", "file", "directory", "config", "auth", "device", "login", "authorization", "unauthorized", "forbidden", "rate", "limit", "server", "unavailable", "retry", "econnreset", "econnrefused", "etimedout", "enotfound", "eacces", "eperm", "enoent", "enospc", "eio", "bad", "not", "found", "no", "such", "initialization", "initialize"]);
/** Returns only closed categories/words. No transcript-derived free text escapes. */
export function classifyNativeLoginFailure(provider: LoginKey, exitCode: number, transcript: string): NativeProviderLoginFailure {
  const safe = transcript.slice(-64 * 1024)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/https?:\/\/\S+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\/(?:[^\s"']+)/gi, " ")
    .replace(/\b[A-Za-z0-9_+=-]{16,}\b|\b[A-Z0-9]{4}[- ][A-Z0-9]{4}\b|\b[A-Z0-9]{6,12}\b/g, word => FAILURE_WORDS.has(word.toLowerCase()) ? word : " ");
  const status = safe.match(/\b(?:HTTP|status|response|error)[^\r\n]{0,24}\b([45]\d{2})\b/i)?.[1];
  const categories: Array<[string, RegExp]> = [
    ["TLS", /certificate|\btls\b|\bssl\b/i], ["proxy", /proxy/i],
    ["network", /network|fetch|ECONN|ENET|ETIMEDOUT|ENOTFOUND|connect/i],
    ["permission", /permission|denied|EACCES|EPERM/i], ["argument", /argument|option|unknown command|unexpected flag/i],
    ["TTY", /terminal|\btty\b|ioctl|tcgetattr/i], ["filesystem", /ENOENT|ENOSPC|no such file|directory|filesystem/i],
  ];
  return { provider, exitCode, errorCategory: status ? `HTTP_${status}` : categories.find(([, pattern]) => pattern.test(safe))?.[0] ?? "unknown", errorWords: (safe.toLowerCase().match(/\b[a-z]+\b/g) ?? []).filter(word => FAILURE_WORDS.has(word)).slice(0, 32) };
}
const ADAPTER_KEYS: Readonly<Record<string, LoginKey>> = { codex_local: "codex", grok_local: "grok", claude_local: "claude" };
const LOGIN_ARGS: Readonly<Record<LoginKey, readonly string[]>> = {
  codex: ["-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"],
  grok: ["login", "--device-auth"],
  claude: ["setup-token"],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_LOGIN_MS = 5 * 60 * 1000;
const fail = () => new Error("Native provider login is unavailable or failed its safety checks.");
// Node's Unix stdio "pipe" is a socketpair. macOS script rejects that stdin;
// this fixed bridge provides a real pipe. script remains the PTY allocator.
const SCRIPT_PIPE_BRIDGE = `import os, signal, subprocess, sys, threading, time
deadline = float(sys.argv[1]) / 1000
child = subprocess.Popen(["/usr/bin/script", "-q", "/dev/null", *sys.argv[2:]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
stopping, stopped = threading.Event(), threading.Event()
stop_lock = threading.Lock()
def stop_child():
    with stop_lock:
        if stopping.is_set(): return
        stopping.set()
    pids = [child.pid]
    for pid in pids:
        if len(pids) >= 64: break
        try: pids.extend(int(x) for x in subprocess.check_output(["/usr/bin/pgrep", "-P", str(pid)], stderr=subprocess.DEVNULL).split())
        except subprocess.CalledProcessError: pass
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid in reversed(pids):
            try: os.killpg(pid, sig)
            except OSError: pass
            try: os.kill(pid, sig)
            except OSError: pass
        if sig == signal.SIGTERM: time.sleep(0.25)
    stopped.set()
watchdog = threading.Timer(max(0.001, deadline - time.time()), stop_child)
watchdog.daemon = True
watchdog.start()
def forward_input():
    try:
        while True:
            chunk = os.read(0, 4096)
            if not chunk: stop_child(); break
            child.stdin.write(chunk)
            child.stdin.flush()
    except (BrokenPipeError, OSError): pass
threading.Thread(target=forward_input, daemon=True).start()
try:
    while True:
        chunk = os.read(child.stdout.fileno(), 4096)
        if not chunk: break
        os.write(1, chunk)
except OSError: stop_child()
result = child.wait()
watchdog.cancel()
if stopping.is_set(): stopped.wait()
sys.exit(result)
`;

export interface NativeProviderLoginScope {
  companyId: string;
  environmentId: string;
  startedByUserId: string;
  adapterType: string;
}
interface LeaseRecord extends NativeProviderLoginScope {
  id: string;
  sessionId: string;
  expiresAt: number;
}
export interface NativeProviderLoginOptions {
  /** Existing canonical private directory, validated by the storage-volume guard. */
  root: string;
  /** Server-owned native CLI paths. Never use an agent/request command override. */
  binaries: Record<LoginKey, string>;
  /** Mandatory recheck of dedicated host capability, local environment and owner permission. */
  assertAuthorized(scope: NativeProviderLoginScope): Promise<void>;
  env?: NodeJS.ProcessEnv;
  onFailure?: (failure: NativeProviderLoginFailure) => void;
}

/** macOS script allocates the real terminal; /dev/null disables transcript storage. */
function openNativePty(key: LoginKey, binary: string, args: readonly string[], home: string, env: NodeJS.ProcessEnv, deadline: number, onFailure?: NativeProviderLoginOptions["onFailure"]): LoginPtySession {
  const childEnv: NodeJS.ProcessEnv = { ...env, CODEX_HOME: home, GROK_HOME: home, CLAUDE_CONFIG_DIR: home };
  for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "XAI_API_KEY", "GROK_API_KEY"]) delete childEnv[name];
  const child = spawn("/usr/bin/python3", ["-I", "-c", SCRIPT_PIPE_BRIDGE, String(deadline), binary, ...args], { cwd: home, env: childEnv, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let listener: ((chunk: string) => void) | null = null;
  let buffered = "";
  let transcript = "";
  let stopped = false;
  let finished = false;
  let stopDone: Promise<void> = Promise.resolve();
  const data = (bytes: Buffer | string) => {
    const chunk = typeof bytes === "string" ? bytes : bytes.toString("utf8");
    transcript = (transcript + chunk).slice(-64 * 1024);
    if (listener) listener(chunk);
    else buffered = (buffered + chunk).slice(-64 * 1024);
  };
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", data); child.stderr.on("data", data);
  // macOS script's command can own another process group. Capture only this
  // server-owned wrapper's descendants before stopping, never a request PID.
  const stop = () => {
    if (stopped || finished) return;
    stopped = true;
    const pids = [child.pid].filter((pid): pid is number => pid !== undefined);
    for (let i = 0; i < pids.length && pids.length < 64; i++) {
      const children = spawnSync("/usr/bin/pgrep", ["-P", String(pids[i])], { encoding: "utf8" }).stdout ?? "";
      for (const value of children.trim().split(/\s+/)) if (/^[1-9][0-9]*$/.test(value)) pids.push(Number(value));
    }
    const signal = (value: NodeJS.Signals) => {
      for (const pid of pids.toReversed()) {
        try { process.kill(-pid, value); } catch {}
        try { process.kill(pid, value); } catch {}
      }
    };
    signal("SIGTERM");
    stopDone = new Promise(resolve => setTimeout(() => { signal("SIGKILL"); resolve(); }, 250));
  };
  const timer = setTimeout(stop, Math.max(1, deadline - Date.now())); timer.unref();
  const done = new Promise<{ exitCode: number | null }>(resolve => {
    const finish = (exitCode: number | null) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (exitCode !== null && exitCode !== 0 && !stopped && Date.now() < deadline) {
        try { onFailure?.(classifyNativeLoginFailure(key, exitCode, transcript)); } catch {}
      }
      transcript = ""; resolve({ exitCode });
    };
    child.once("error", () => finish(null)); child.once("close", code => finish(code));
  });
  return {
    onData(callback) { if (listener) throw fail(); listener = callback; if (buffered) callback(buffered); buffered = ""; },
    write(value) { if (!stopped && !finished) child.stdin.write(value); },
    wait: () => done,
    kill: stop,
    async close() { stop(); await done; await stopDone; child.stdout.removeListener("data", data); child.stderr.removeListener("data", data); listener = null; buffered = ""; child.stdin.destroy(); },
  };
}

/** Reuses existing state machines; this module owns only private homes and PTYs. */
export function createNativeProviderLoginRuntime(options: NativeProviderLoginOptions) {
  const root = path.resolve(options.root);
  const sessions = new Map<string, LoginPtySession>();
  const leases = new Map<string, LeaseRecord>();
  const env = options.env ?? process.env;
  async function assertRoot() {
    if (process.platform !== "darwin" || !path.isAbsolute(options.root) || await realpath(root) !== root) throw fail();
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw fail();
  }
  const homeFor = (id: string) => { if (!UUID.test(id)) throw fail(); return path.join(root, id); };
  async function acquire(scope: NativeProviderLoginScope, sessionId: string, deadline: number) {
    if (!scope.companyId || !scope.environmentId || !scope.startedByUserId || !ADAPTER_KEYS[scope.adapterType] || !UUID.test(sessionId) || !Number.isFinite(deadline) || deadline <= Date.now()) throw fail();
    await options.assertAuthorized(scope); await assertRoot();
    const key = ADAPTER_KEYS[scope.adapterType];
    const configuredBinary = options.binaries[key];
    if (!configuredBinary || !path.isAbsolute(configuredBinary)) throw fail();
    const binary = await realpath(configuredBinary); await access(binary, constants.X_OK);
    const id = randomUUID(); const home = homeFor(id);
    const record: LeaseRecord = { ...scope, id, sessionId, expiresAt: Math.min(deadline, Date.now() + MAX_LOGIN_MS) };
    await mkdir(home, { mode: 0o700 });
    try {
      await writeFile(path.join(home, "lease.json"), JSON.stringify(record), { mode: 0o600, flag: "wx" });
      if (key === "codex") await writeFile(path.join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600, flag: "wx" });
      leases.set(id, record);
    } catch { await rm(home, { recursive: true, force: true }); throw fail(); }
    let opened = false;
    const openPtySession: LoginPtySessionOpener = async (_ignoredCommand) => {
      if (opened || !leases.has(id) || record.expiresAt <= Date.now()) throw fail();
      opened = true;
      await options.assertAuthorized(record); await assertRoot();
      const stat = await lstat(home);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw fail();
      const session = openNativePty(key, binary, LOGIN_ARGS[key], home, env, record.expiresAt, options.onFailure);
      sessions.set(id, session); return session;
    };
    return { record, home, openPtySession };
  }
  async function releaseById(id: string): Promise<void> {
    await assertRoot(); const home = homeFor(id);
    await sessions.get(id)?.close(); sessions.delete(id); leases.delete(id);
    await rm(home, { recursive: true, force: true });
  }
  const device: LoginSessionRuntime = {
    async acquireLoginLease(input: AcquireLoginLeaseInput) {
      if (!['codex_local', 'grok_local'].includes(input.adapterType)) throw fail();
      const acquired = await acquire(input, input.sessionId, Date.now() + MAX_LOGIN_MS);
      const transport = createLoginPtyTransport(acquired.openPtySession);
      return {
        providerLeaseId: acquired.record.id,
        authPath: path.join(acquired.home, "auth.json"),
        driver: {
          start: (command, onData) => transport.start(command, onData),
          async readFile(_ignoredPath) { return Buffer.from(await readLocalAiCredentialFile(path.join(acquired.home, "auth.json")), "utf8"); },
          dispose: () => transport.dispose(),
        },
        async deleteSandbox() { await releaseById(acquired.record.id); return { outcome: "deleted" as const }; },
        release: () => releaseById(acquired.record.id),
      };
    },
  };
  const setupToken: SetupTokenSandboxProvider = {
    async acquire({ scope, deadline }) {
      if (scope.adapterType !== "claude_local") throw fail();
      const acquired = await acquire({ companyId: scope.companyId, environmentId: scope.environmentId, adapterType: scope.adapterType, startedByUserId: scope.ownerUserId }, randomUUID(), deadline);
      return { leaseId: acquired.record.id, openPtySession: acquired.openPtySession };
    },
    release: releaseById,
  };
  return {
    device, setupToken, releaseById,
    /** Caller must fence durable promotion claims before approving orphan cleanup. */
    async reapExpired(mayRelease: (record: Readonly<LeaseRecord>) => Promise<boolean>, now = Date.now()) {
      await assertRoot();
      for (const id of await readdir(root)) {
        if (!UUID.test(id)) continue;
        let record: LeaseRecord;
        try { record = JSON.parse(await readLocalAiCredentialFile(path.join(homeFor(id), "lease.json"))); } catch { continue; }
        if (record.id !== id || !Number.isFinite(record.expiresAt) || record.expiresAt > now) continue;
        if (await mayRelease(record)) await releaseById(id);
      }
    },
    async shutdown() { for (const id of [...leases.keys()]) await releaseById(id); },
  };
}
