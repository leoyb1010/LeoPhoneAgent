// [leo] 测试进程的 HOME 隔离 + 真实用户数据写入守卫。
//
// 所有 vitest（setupFiles / globalSetup）与 node:test（--import）在加载任何业务代码之前先跑这里：
//   1. HOME / ZCODE_HOME / XDG_* / CLAUDE_CONFIG_DIR / CODEX_HOME 指向本次运行的临时目录；
//   2. os.homedir() 若仍解析到真实用户目录就直接抛错（隔离没生效时宁可整轮失败）；
//   3. 给 fs 的写入类 API 装守卫：目标落在真实 ~/.leophoneagent、~/.leoagent、~/.zcode、~/.claude、
//      ~/.codex 或 LeoBot 的 Application Support 下即抛错——即使有代码绕过 HOME（os.userInfo、
//      写死的绝对路径），也不会再碰用户数据。
// 原因：2026-10-17 发现大量用例没隔离 HOME，写进了真实 ~/.leophoneagent（v2/credentials.json、
// cli/plugins/data、cli/workflows/runs …）。
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GUARD_FLAG = Symbol.for("leo.testHomeIsolation.installed");

function realUserHome() {
  try {
    return os.userInfo().homedir;
  } catch {
    return undefined;
  }
}

export function isolateTestHome() {
  const realHome = realUserHome();
  let home = process.env.LEO_TEST_HOME;
  if (!home || !fs.existsSync(home) || (realHome && isInside(home, realHome) && !isInside(home, os.tmpdir()))) {
    home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "leo-test-home-"));
    process.env.LEO_TEST_HOME = home;
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ZCODE_HOME = path.join(home, ".leophoneagent");
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
  process.env.XDG_CACHE_HOME = path.join(home, ".cache");
  process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  process.env.CODEX_HOME = path.join(home, ".codex");
  // 这些变量若带着真实路径进来，会绕过 HOME。
  for (const key of ["ZCODE_STORAGE_DIR", "ZCODE_DATA_BASE_DIR", "ZCODE_DESKTOP_USER_DATA_DIR", "ZCODE_DESKTOP_SESSION_DATA_DIR", "ZCODE_DESKTOP_HOME_DIR", "LEO_ACP_AGENT_HOME"]) {
    const value = process.env[key];
    if (value && realHome && isInside(value, realHome) && !isInside(value, home)) delete process.env[key];
  }
  if (realHome && path.resolve(os.homedir()) === path.resolve(realHome)) {
    throw new Error(`[leo-test-isolation] os.homedir() still resolves to the real home (${realHome})`);
  }
  installWriteGuard(realHome);
  return home;
}

function isInside(target, root) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function protectedRoots(realHome) {
  if (!realHome) return [];
  return [
    ".leophoneagent",
    ".leoagent",
    ".zcode",
    ".claude",
    ".codex",
    path.join("Library", "Application Support", "LeoPhoneAgent"),
    path.join("Library", "Application Support", "LeoPhoneAgent Dev"),
    path.join("Library", "Application Support", "LeoBot"),
  ].map((entry) => path.join(realHome, entry));
}

function toPath(value) {
  if (typeof value === "string") return value;
  if (value instanceof URL) return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return value.toString();
  return undefined;
}

function installWriteGuard(realHome) {
  if (globalThis[GUARD_FLAG]) return;
  globalThis[GUARD_FLAG] = true;
  const roots = protectedRoots(realHome);
  if (roots.length === 0) return;
  const check = (target) => {
    const resolved = toPath(target);
    if (!resolved) return;
    const absolute = path.resolve(resolved);
    for (const root of roots) {
      if (isInside(absolute, root)) {
        throw new Error(`[leo-test-isolation] test tried to write real user data: ${absolute}`);
      }
    }
  };
  const isWriteFlag = (flags) =>
    typeof flags === "number"
      ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND)) !== 0
      : typeof flags === "string" && /[wa+]/.test(flags);

  const wrap = (owner, name, guard) => {
    const original = owner[name];
    if (typeof original !== "function") return;
    owner[name] = function guarded(...args) {
      guard(...args);
      return original.apply(this, args);
    };
  };
  const first = (target) => check(target);
  const second = (_source, destination) => check(destination);
  const both = (source, destination) => {
    check(source);
    check(destination);
  };
  const openGuard = (target, flags) => {
    if (isWriteFlag(flags)) check(target);
  };
  const streamGuard = (target) => check(target);

  for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "rmdirSync", "unlinkSync", "truncateSync", "mkdtempSync", "utimesSync", "chmodSync"]) wrap(fs, name, first);
  for (const name of ["writeFile", "appendFile", "mkdir", "rm", "rmdir", "unlink", "truncate", "mkdtemp", "utimes", "chmod"]) wrap(fs, name, first);
  for (const name of ["renameSync", "rename"]) wrap(fs, name, both);
  for (const name of ["copyFileSync", "copyFile", "cpSync", "cp", "symlinkSync", "symlink", "linkSync", "link"]) wrap(fs, name, second);
  wrap(fs, "openSync", openGuard);
  wrap(fs, "open", openGuard);
  wrap(fs, "createWriteStream", streamGuard);
  const promises = fs.promises;
  for (const name of ["writeFile", "appendFile", "mkdir", "rm", "rmdir", "unlink", "truncate", "mkdtemp", "utimes", "chmod"]) wrap(promises, name, first);
  wrap(promises, "rename", both);
  for (const name of ["copyFile", "cp", "symlink", "link"]) wrap(promises, name, second);
  wrap(promises, "open", openGuard);
  syncBuiltinESMExports();
}

isolateTestHome();
