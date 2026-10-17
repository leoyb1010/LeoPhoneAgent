#!/usr/bin/env node
// [fix-remote] ACP 外部 agent 冒烟：直接起 agent → initialize → session/new → prompt「只回复OK」→ 打印结果。
// 单文件、只用 Node 内置模块：可以拷到任何一台 Mac 上直接跑（不需要仓库依赖）。
//
//   node scripts/leo-acp-smoke.mjs <claude|codex|gemini|opencode|grok> [--cwd DIR] [--timeout 120] [--prompt 文本]
//
// 探测路径与 LeoBot 一致（packages/shared/src/acp-detect.ts）：进程 PATH + 登录 shell 的 PATH + 常见用户级安装目录。
// 退出码：0 = agent 回了话且正常结束；1 = 启动/握手/回合失败；2 = 用法错误或本机没装。
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const agent = args.find((arg) => !arg.startsWith("--"));
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const cwd = flag("cwd", process.cwd());
const timeoutMs = Number(flag("timeout", "120")) * 1000;
const promptText = flag("prompt", "只回复OK");

const home = process.env.HOME?.trim() || homedir();

function loginShellPath() {
  if (process.platform !== "darwin") return [];
  const shell = process.env.SHELL?.trim() || "/bin/zsh";
  const result = spawnSync(shell, ["-lic", "printf '__LEOPATH__%s__LEOPATH__' \"$PATH\""], {
    encoding: "utf8",
    timeout: 4000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const match = /__LEOPATH__(.*?)__LEOPATH__/s.exec(result.stdout ?? "");
  return match ? match[1].split(delimiter).filter(Boolean) : [];
}

function nvmBins() {
  const root = join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(root)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((version) => join(root, version, "bin"));
  } catch {
    return [];
  }
}

const searchPath = [
  ...new Set([
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
    ...loginShellPath(),
    join(home, ".local", "bin"),
    join(home, ".grok", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".local", "npm-global", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".opencode", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...nvmBins(),
  ]),
];

function which(name, dirs = searchPath) {
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

function claudeAdapterEntry() {
  const candidates = [
    process.env.LEO_CLAUDE_AGENT_ACP_ENTRY,
    "/Applications/LeoBot.app/Contents/Resources/glm/acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
    join(home, "Applications/LeoBot.app/Contents/Resources/glm/acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"),
    new URL("../node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js", import.meta.url).pathname,
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

function resolveLaunch(id) {
  const env = { ...process.env, PATH: searchPath.join(delimiter) };
  switch (id) {
    case "claude":
    case "claude-code": {
      const cli = which("claude", [join(home, ".local", "bin"), join(home, ".claude", "local")]) ?? which("claude");
      const entry = claudeAdapterEntry();
      if (!cli) return { error: "没有找到 claude 命令" };
      if (!entry) return { error: "没有找到 claude-agent-acp 适配器（装了 LeoBot.app 吗？或设置 LEO_CLAUDE_AGENT_ACP_ENTRY）" };
      return { cli, command: process.execPath, args: [entry], env: { ...env, CLAUDE_CODE_EXECUTABLE: cli } };
    }
    case "codex": {
      const cli = which("codex");
      const adapter = which("codex-acp");
      if (adapter) return { cli, command: adapter, args: [], env: { ...env, ...(cli ? { CODEX_PATH: cli } : {}) } };
      const npx = which("npx");
      if (!cli) return { error: "没有找到 codex 命令" };
      if (!npx) return { error: "没有 codex-acp，也没有 npx 可以拉取它" };
      return { cli, command: npx, args: ["-y", "@agentclientprotocol/codex-acp@2.2.2"], env: { ...env, CODEX_PATH: cli } };
    }
    case "gemini": {
      const cli = which("gemini");
      return cli ? { cli, command: cli, args: ["--acp"], env } : { error: "没有找到 gemini 命令" };
    }
    case "opencode": {
      const cli = which("opencode");
      return cli ? { cli, command: cli, args: ["acp"], env } : { error: "没有找到 opencode 命令" };
    }
    case "grok": {
      const cli = which("grok", [join(home, ".grok", "bin"), ...searchPath]);
      return cli ? { cli, command: cli, args: ["agent", "stdio"], env } : { error: "没有找到 grok 命令" };
    }
    default:
      return { error: `不认识的 agent：${id}` };
  }
}

if (!agent) {
  console.error("用法：node scripts/leo-acp-smoke.mjs <claude|codex|gemini|opencode|grok> [--cwd DIR] [--timeout 秒] [--prompt 文本]");
  process.exit(2);
}

const launch = resolveLaunch(agent);
if (launch.error) {
  console.error(`✗ ${agent}: ${launch.error}`);
  console.error(`  搜索路径：${searchPath.join(delimiter)}`);
  process.exit(2);
}
if (launch.cli) {
  const version = spawnSync(launch.cli, ["--version"], { encoding: "utf8", timeout: 5000, env: launch.env });
  console.log(`· CLI      ${launch.cli}  ${(version.stdout || version.stderr || "").trim().split("\n")[0] ?? ""}`);
}
console.log(`· 启动     ${launch.command} ${launch.args.join(" ")}`);
console.log(`· 工作目录 ${cwd}`);

const started = Date.now();
const child = spawn(launch.command, launch.args, {
  cwd,
  env: { ...launch.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
const stderrTail = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  for (const line of String(chunk).split("\n")) if (line.trim()) stderrTail.push(line);
  while (stderrTail.length > 15) stderrTail.shift();
});

let nextId = 1;
const pending = new Map();
let reply = "";
const notes = [];

function send(message) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}
function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}

function finish(code, message) {
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (code === 0) console.log(`✓ ${agent} 正常（${seconds}s）：${message}`);
  else {
    console.error(`✗ ${agent} 失败（${seconds}s）：${message}`);
    if (stderrTail.length > 0) console.error(`  agent stderr 最后几行：\n    ${stderrTail.join("\n    ")}`);
  }
  if (notes.length > 0) console.log(`  备注：${[...new Set(notes)].join("；")}`);
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  process.exit(code);
}

createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    notes.push("stdout 里有非 JSON 行（已忽略）");
    return;
  }
  if (message.id !== undefined && !message.method) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(Object.assign(new Error(message.error.message ?? "error"), { rpc: message.error }));
    else waiter.resolve(message.result);
    return;
  }
  if (message.method === "session/update") {
    const update = message.params?.update ?? {};
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") reply += update.content.text;
    return;
  }
  if (message.method === "session/request_permission" && message.id !== undefined) {
    // 冒烟不放行任何工具：拒绝（没有拒绝选项就取消）。
    const reject = (message.params?.options ?? []).find((option) => String(option.kind).startsWith("reject"));
    send({
      id: message.id,
      result: { outcome: reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" } },
    });
    notes.push("agent 请求了工具授权（已拒绝）");
    return;
  }
  if (message.id !== undefined && message.method) {
    send({ id: message.id, error: { code: -32601, message: `unsupported: ${message.method}` } });
    notes.push(`agent 发来不支持的请求 ${message.method}`);
  }
});

child.on("error", (error) => finish(1, `进程启动失败：${error.message}`));
child.on("exit", (code, signal) => finish(1, `agent 进程退出（code=${code ?? "null"} signal=${signal ?? "null"}）`));
setTimeout(() => finish(1, `超时（${timeoutMs / 1000}s）`), timeoutMs).unref();

const describe = (error) => {
  const rpc = error?.rpc;
  if (!rpc) return String(error?.message ?? error);
  const auth = rpc.code === -32000 || /auth/i.test(String(rpc.message));
  return `${rpc.message}（code ${rpc.code}）${auth ? " → 未登录：在这台 Mac 的终端里先登录该 CLI" : ""}${
    rpc.data ? ` ${JSON.stringify(rpc.data).slice(0, 300)}` : ""
  }`;
};

try {
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "LeoBot-smoke", version: "1" },
  });
  console.log(`· 握手     protocol=${init?.protocolVersion} agent=${init?.agentInfo?.name ?? "?"} ${init?.agentInfo?.version ?? ""}`);
  const session = await request("session/new", { cwd, mcpServers: [] });
  console.log(`· 会话     ${session?.sessionId}`);
  const result = await request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: promptText }],
  });
  const text = reply.trim();
  if (result?.stopReason === "end_turn" && text) finish(0, `stopReason=end_turn 回复：${text.slice(0, 200)}`);
  else finish(1, `stopReason=${result?.stopReason ?? "?"} 回复：${text ? text.slice(0, 200) : "（空）"}`);
} catch (error) {
  finish(1, describe(error));
}
