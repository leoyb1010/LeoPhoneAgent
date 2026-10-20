// [fix-remote] 手机经 Leo Link 用远程 Mac 上的 CLI：grok 走 ACP、GUI 启动时的短 PATH 也能找到 CLI、
// 外部 agent 失败时给手机的错误说清是谁、为什么、怎么修。
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
} from "@agentclientprotocol/sdk";
import type { ModelEvent } from "@zcode/contracts";
import {
  acpSearchPath,
  claudeOAuthTokenPath,
  detectAcpAgent,
  resolveAcpLaunch,
  writeClaudeOAuthToken,
  type AcpLaunchSpec,
} from "../../src/acp/catalog.js";
import { describeAcpFailure, redactAgentOutput } from "../../src/acp/errors.js";
import { AcpModel } from "../../src/acp/model.js";
import { AcpSessionManager } from "../../src/acp/manager.js";
import { connectAcpStream, orderAuthMethods, type ConnectAcpAgentOptions } from "../../src/acp/process.js";
import { geminiAuthPreference } from "@zcode/shared/acp-detect";

function makeExecutable(dir: string, name: string, body = "#!/bin/sh\nexit 0\n"): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("grok: found in ~/.grok/bin even when the GUI PATH is only /usr/bin, launched as `grok agent stdio`", () => {
  const home = mkdtempSync(join(tmpdir(), "leo-acp-grok-"));
  const grok = makeExecutable(join(home, ".grok", "bin"), "grok");
  const env = { PATH: "/usr/bin:/bin", HOME: home };
  const status = detectAcpAgent("grok", { env });
  assert.equal(status.available, true);
  assert.equal(status.cliPath, grok);
  assert.equal(status.loginCommand, "grok login");
  const launch = resolveAcpLaunch("grok", { env });
  assert.ok(launch);
  assert.equal(launch.command, grok);
  assert.deepEqual(launch.args, ["agent", "stdio"]);
  assert.ok(launch.env.PATH!.split(delimiter).includes(join(home, ".grok", "bin")));
});

test("search path covers user-level installs (npm-global, bun, opencode, nvm newest first) for every agent", () => {
  const home = mkdtempSync(join(tmpdir(), "leo-acp-path-"));
  mkdirSync(join(home, ".nvm", "versions", "node", "v20.1.0", "bin"), { recursive: true });
  mkdirSync(join(home, ".nvm", "versions", "node", "v24.15.0", "bin"), { recursive: true });
  const dirs = acpSearchPath({ PATH: "/usr/bin", HOME: home });
  assert.equal(dirs[0], "/usr/bin");
  for (const expected of [
    join(home, ".local", "bin"),
    join(home, ".grok", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".local", "npm-global", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".opencode", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]) {
    assert.ok(dirs.includes(expected), expected);
  }
  const nvm24 = dirs.indexOf(join(home, ".nvm", "versions", "node", "v24.15.0", "bin"));
  const nvm20 = dirs.indexOf(join(home, ".nvm", "versions", "node", "v20.1.0", "bin"));
  assert.ok(nvm24 >= 0 && nvm20 > nvm24);

  // gemini 装在 nvm 下：GUI PATH 里没有它也能探测到。
  makeExecutable(join(home, ".nvm", "versions", "node", "v24.15.0", "bin"), "gemini");
  assert.equal(detectAcpAgent("gemini", { env: { PATH: "/usr/bin", HOME: home } }).available, true);
  const missing = detectAcpAgent("opencode", { env: { PATH: "/nonexistent", HOME: home } });
  assert.equal(missing.available, false);
  assert.match(missing.unavailableReason ?? "", /没有找到 opencode/);
});

test("auth_required becomes an actionable message naming the agent, with redacted stderr", () => {
  const error = describeAcpFailure({
    agentId: "claude-code",
    error: RequestError.authRequired(),
    stderrTail: ["loading config from /Users/alice/.claude", "Error: token=abcdef1234567890 rejected", "please log in"],
    home: "/Users/alice",
  });
  assert.equal(error.kind, "auth");
  assert.match(error.message, /^Claude Code 在这台 Mac 上未登录或读不到登录态：在这台 Mac 的终端运行 claude 并 \/login/);
  assert.match(error.message, /agent 最后输出：/);
  assert.doesNotMatch(error.message, /abcdef1234567890/);
  assert.doesNotMatch(error.detail ?? "", /\/Users\/alice/);
  assert.ok(error.message.length <= 480);
});

test("redaction hides keys, bearer tokens and JWT-looking strings", () => {
  const out = redactAgentOutput(
    "key sk-ant-api03-AAAAAAAAAAAAAAAA Authorization: Bearer xyz.abc api_key=\"q1w2e3r4t5\" eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
    "/Users/bob",
  );
  assert.doesNotMatch(out, /sk-ant-api03-A/);
  assert.doesNotMatch(out, /xyz\.abc/);
  assert.doesNotMatch(out, /q1w2e3r4t5/);
  assert.doesNotMatch(out, /eyJhbGci/);
});

test("ACP session/new auth failure reaches the turn as a readable error (not bare 'Authentication required')", async () => {
  const manager = new AcpSessionManager({
    statePath: join(mkdtempSync(join(tmpdir(), "leo-acp-auth-")), "acp-sessions.json"),
    environment: {
      env: { PATH: makeExecutable(join(mkdtempSync(join(tmpdir(), "leo-acp-bin-")), "bin"), "grok").replace(/\/grok$/, ""), HOME: "/nonexistent" },
    },
    connect: async (_launch: unknown, options: ConnectAcpAgentOptions) => {
      const toAgent = new TransformStream<Uint8Array, Uint8Array>();
      const toClient = new TransformStream<Uint8Array, Uint8Array>();
      const agent: Agent = {
        initialize: async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }),
        newSession: async () => {
          throw RequestError.authRequired({}, "no auth method id provided");
        },
        authenticate: async () => ({}),
        prompt: async () => ({ stopReason: "end_turn" }),
        cancel: async () => undefined,
      };
      new AgentSideConnection(() => agent, ndJsonStream(toClient.writable, toAgent.readable));
      return connectAcpStream(ndJsonStream(toAgent.writable, toClient.readable), options);
    },
  });
  const model = new AcpModel({ agentId: "grok", leoSessionId: "sess_auth", cwd: () => "/w", manager });
  await assert.rejects(
    collect(model.streamText({ messages: [{ role: "user", content: "hi" }] })),
    /Grok 在这台 Mac 上未登录或读不到登录态：在这台 Mac 的终端运行 grok login/,
  );
});

test("agent process dying mid-turn ends the turn with which agent, why, and its last stderr lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leo-acp-crash-"));
  // 一个最小的 ACP agent：握手、开会话，收到 prompt 就往 stderr 打两行后退出。
  const script = `#!${process.execPath}
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (msg.method === "session/new") send({ id: msg.id, result: { sessionId: "s1" } });
  else if (msg.method === "session/prompt") {
    process.stderr.write("panic: model backend unreachable\\nretry with api_key=supersecretvalue failed\\n");
    setTimeout(() => process.exit(3), 50);
  }
});
`;
  makeExecutable(join(dir, "bin"), "grok", script);
  const manager = new AcpSessionManager({
    statePath: join(dir, "acp-sessions.json"),
    environment: { env: { PATH: join(dir, "bin"), HOME: dir } },
  });
  const model = new AcpModel({ agentId: "grok", leoSessionId: "sess_crash", cwd: () => dir, manager });
  try {
    const events = await collect(model.streamText({ messages: [{ role: "user", content: "hi" }] }));
    const failure = events.find((event) => event.type === "error");
    assert.ok(failure && failure.type === "error");
    const message = (failure.error as Error).message;
    // SDK 先因 stdout 关闭拒掉 prompt（连接断开），或先收到 exit（退出码）：两种都是同一个可读结论。
    assert.match(message, /^Grok 进程意外退出（(退出码 3|连接断开)）/);
    assert.match(message, /model backend unreachable/);
    assert.doesNotMatch(message, /supersecretvalue/);
  } finally {
    manager.disposeAll();
  }
});

// [fix-remote] G：钥匙串登录过期 / 读不到时，Claude Code 用数据根里的长期令牌（claude setup-token）。
const TOKEN = "sk-ant-oat01-TESTTOKENabcdefghijklmnopqrstuvwxyz0123456789";

function claudeEnvironment(withToken: boolean) {
  const home = mkdtempSync(join(tmpdir(), "leo-acp-claude-"));
  const dataRoot = join(home, "data");
  makeExecutable(join(home, ".local", "bin"), "claude");
  if (withToken) {
    mkdirSync(join(dataRoot, "acp"), { recursive: true });
    writeFileSync(join(dataRoot, "acp", "claude-oauth-token"), `${TOKEN}\n`, { mode: 0o600 });
  }
  return {
    env: {
      PATH: "/usr/bin",
      HOME: home,
      ZCODE_HOME: dataRoot,
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: "1",
      CLAUDE_CODE_SESSION_ID: "host-session",
    },
    resolveClaudeAgentAcpEntry: () => "/fake/claude-agent-acp.js",
    nodePath: "/fake/node",
  };
}

test("Claude Code: the long-lived token file becomes CLAUDE_CODE_OAUTH_TOKEN and host session vars are dropped", () => {
  const environment = claudeEnvironment(true);
  const status = detectAcpAgent("claude-code", environment);
  assert.equal(status.longLivedToken, true);
  const launch = resolveAcpLaunch("claude-code", environment);
  assert.ok(launch);
  assert.equal(launch.env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH", "CLAUDE_CODE_SESSION_ID"]) {
    assert.equal(launch.env[key], undefined, key);
  }
});

test("Claude Code: no token file → no CLAUDE_CODE_OAUTH_TOKEN, and no token status", () => {
  const environment = claudeEnvironment(false);
  assert.equal(detectAcpAgent("claude-code", environment).longLivedToken, undefined);
  const launch = resolveAcpLaunch("claude-code", environment);
  assert.ok(launch);
  assert.equal(launch.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test("Claude Code: the token never reaches logs or the phone's error text", async () => {
  const environment = claudeEnvironment(true);
  const logged: string[] = [];
  let launched: AcpLaunchSpec | undefined;
  const manager = new AcpSessionManager({
    statePath: join(environment.env.HOME, "acp-sessions.json"),
    environment,
    logger: { warn: (message, context) => logged.push(`${message} ${JSON.stringify(context)}`) },
    connect: async (launch: AcpLaunchSpec, options: ConnectAcpAgentOptions) => {
      launched = launch;
      options.onStderr?.(`debug: using CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\nauth failed for ${TOKEN}\n`);
      throw RequestError.authRequired();
    },
  });
  const model = new AcpModel({ agentId: "claude-code", leoSessionId: "sess_token", cwd: () => "/w", manager });
  const failure = await collect(model.streamText({ messages: [{ role: "user", content: "hi" }] })).then(
    () => undefined,
    (error: unknown) => error as Error,
  );
  assert.equal(launched?.env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.ok(failure);
  assert.match(failure.message, /Claude Code 在这台 Mac 上未登录或读不到登录态/);
  assert.ok(logged.length > 0);
  for (const text of [...logged, failure.message, (failure as { detail?: string }).detail ?? ""]) {
    assert.ok(!text.includes(TOKEN), text);
    assert.ok(!text.includes("TESTTOKEN"), text);
  }
});

test("pasting the token writes it 0600 under the data root; an empty paste removes it", async () => {
  const environment = claudeEnvironment(false);
  await writeClaudeOAuthToken(`  ${TOKEN}  `, environment.env);
  const file = claudeOAuthTokenPath(environment.env);
  assert.equal(readFileSync(file, "utf8").trim(), TOKEN);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  await assert.rejects(writeClaudeOAuthToken("not a token", environment.env), /令牌格式不对/);
  await writeClaudeOAuthToken("", environment.env);
  assert.equal(existsSync(file), false);
});

test("[fix-remote] I: a proxy already in the user's env reaches the agent untouched", () => {
  const home = mkdtempSync(join(tmpdir(), "leo-acp-proxy-"));
  makeExecutable(join(home, ".grok", "bin"), "grok");
  const launch = resolveAcpLaunch("grok", {
    env: { PATH: "/usr/bin", HOME: home, HTTPS_PROXY: "http://corp:3128", NO_PROXY: "corp.internal" },
  });
  assert.equal(launch?.env.HTTPS_PROXY, "http://corp:3128");
  assert.equal(launch?.env.NO_PROXY, "corp.internal");
  assert.equal(launch?.env.ALL_PROXY, undefined);
});

test("[fix-remote] J: a turn that ends with no output and zero usage is a failure with stopReason and stderr", async () => {
  const manager = new AcpSessionManager({
    statePath: join(mkdtempSync(join(tmpdir(), "leo-acp-empty-")), "acp-sessions.json"),
    connect: async (_launch: unknown, options: ConnectAcpAgentOptions) => {
      options.onStderr?.("Error: must specify GEMINI_API_KEY environment variable\n");
      const toAgent = new TransformStream<Uint8Array, Uint8Array>();
      const toClient = new TransformStream<Uint8Array, Uint8Array>();
      const agent: Agent = {
        initialize: async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }),
        newSession: async () => ({ sessionId: "s" }),
        authenticate: async () => ({}),
        prompt: async () => ({ stopReason: "end_turn" }),
        cancel: async () => undefined,
      };
      new AgentSideConnection(() => agent, ndJsonStream(toClient.writable, toAgent.readable));
      return connectAcpStream(ndJsonStream(toAgent.writable, toClient.readable), options);
    },
    environment: (() => {
      const home = mkdtempSync(join(tmpdir(), "leo-acp-gem-"));
      makeExecutable(join(home, "bin"), "gemini");
      return { env: { PATH: join(home, "bin"), HOME: home } };
    })(),
  });
  const model = new AcpModel({ agentId: "gemini", leoSessionId: "sess_empty", cwd: () => "/w", manager });
  const events = await collect(model.streamText({ messages: [{ role: "user", content: "hi" }] }));
  const failure = events.find((event) => event.type === "error");
  assert.ok(failure && failure.type === "error", JSON.stringify(events));
  const message = (failure.error as Error).message;
  assert.match(message, /^Gemini 这一轮没有任何输出就结束了（stopReason=end_turn）/);
  assert.match(message, /GEMINI_API_KEY/);
  assert.equal(events.some((event) => event.type === "finish"), false);
});

test("[fix-remote] J: gemini picks up ~/.gemini/.env keys when the env has none, never overriding", () => {
  const home = mkdtempSync(join(tmpdir(), "leo-acp-gemenv-"));
  makeExecutable(join(home, "bin"), "gemini");
  mkdirSync(join(home, ".gemini"));
  writeFileSync(
    join(home, ".gemini", ".env"),
    '# key\nexport GEMINI_API_KEY="AIzaTESTKEY123456"\nGOOGLE_GEMINI_BASE_URL=https://proxy.example/gemini # comment\nGOOGLE_GEMINI_MODEL=gemini-3-pro\nUNRELATED=1\n',
  );
  const launch = resolveAcpLaunch("gemini", { env: { PATH: join(home, "bin"), HOME: home } });
  assert.equal(launch?.env.GEMINI_API_KEY, "AIzaTESTKEY123456");
  assert.equal(launch?.env.GOOGLE_GEMINI_BASE_URL, "https://proxy.example/gemini");
  assert.equal(launch?.env.GOOGLE_GEMINI_MODEL, "gemini-3-pro");
  assert.equal(launch?.env.UNRELATED, undefined);
  const own = resolveAcpLaunch("gemini", { env: { PATH: join(home, "bin"), HOME: home, GEMINI_API_KEY: "mine" } });
  assert.equal(own?.env.GEMINI_API_KEY, "mine");
  assert.equal(own?.env.GOOGLE_GEMINI_MODEL, undefined);
});

// [fix-remote] K：开会话报 auth_required 时按本机登录状态 authenticate 再重试；每个握手阶段独立超时。
function scriptedAgentManager(
  makeAgent: (conn: () => AgentSideConnection) => Agent,
  stageTimeouts?: ConnectAcpAgentOptions["stageTimeouts"],
  authPreference?: string[],
) {
  return new AcpSessionManager({
    statePath: join(mkdtempSync(join(tmpdir(), "leo-acp-auth2-")), "acp-sessions.json"),
    environment: (() => {
      const home = mkdtempSync(join(tmpdir(), "leo-acp-authhome-"));
      makeExecutable(join(home, "bin"), "grok");
      makeExecutable(join(home, "bin"), "gemini");
      return { env: { PATH: join(home, "bin"), HOME: home } };
    })(),
    connect: async (_launch: unknown, options: ConnectAcpAgentOptions) => {
      const toAgent = new TransformStream<Uint8Array, Uint8Array>();
      const toClient = new TransformStream<Uint8Array, Uint8Array>();
      let conn!: AgentSideConnection;
      const agent = makeAgent(() => conn);
      conn = new AgentSideConnection(() => agent, ndJsonStream(toClient.writable, toAgent.readable));
      return connectAcpStream(ndJsonStream(toAgent.writable, toClient.readable), {
        ...options,
        ...(stageTimeouts ? { stageTimeouts } : {}),
        ...(authPreference ? { authPreference } : {}),
      });
    },
  });
}

test("K: grok-style agent: newSession auth_required → authenticate(grok.com) → session opens and the turn runs", async () => {
  const methods: string[] = [];
  let authed = false;
  const manager = scriptedAgentManager(
    (conn) => ({
      initialize: async () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
        authMethods: [{ id: "other", name: "Other" }, { id: "grok.com", name: "Grok" }],
      }),
      authenticate: async (params) => {
        methods.push(params.methodId);
        authed = true;
        return {};
      },
      newSession: async () => {
        if (!authed) throw RequestError.authRequired({}, "no auth method id provided");
        return { sessionId: "s" };
      },
      prompt: async (params) => {
        await conn().sessionUpdate({
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } },
        });
        return { stopReason: "end_turn" };
      },
      cancel: async () => undefined,
    }),
    undefined,
    ["grok.com"],
  );
  const model = new AcpModel({ agentId: "grok", leoSessionId: "sess_k1", cwd: () => "/w", manager });
  const events = await collect(model.streamText({ messages: [{ role: "user", content: "hi" }] }));
  assert.deepEqual(methods, ["grok.com"]);
  assert.equal(events.some((event) => event.type === "error"), false, JSON.stringify(events));
  assert.ok(events.some((event) => event.type === "text_delta" && event.text === "OK"));
});

test("K: a stalled authenticate reports which step hung, with the device-auth hint", async () => {
  const agent: Agent = {
    initialize: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      authMethods: [{ id: "grok.com", name: "Grok" }],
    }),
    authenticate: () => new Promise(() => undefined),
    newSession: async () => {
      throw RequestError.authRequired();
    },
    prompt: async () => ({ stopReason: "end_turn" }),
    cancel: async () => undefined,
  };
  const manager = scriptedAgentManager(() => agent, { authenticate: 50 });
  const model = new AcpModel({ agentId: "grok", leoSessionId: "sess_k2", cwd: () => "/w", manager });
  await assert.rejects(
    collect(model.streamText({ messages: [{ role: "user", content: "hi" }] })),
    /Grok 卡在登录（authenticate）这一步.*grok login --device-auth/,
  );
});

test("K: a stalled initialize says so instead of spinning forever", async () => {
  const agent: Agent = {
    initialize: () => new Promise(() => undefined),
    authenticate: async () => ({}),
    newSession: async () => ({ sessionId: "s" }),
    prompt: async () => ({ stopReason: "end_turn" }),
    cancel: async () => undefined,
  };
  const manager = scriptedAgentManager(() => agent, { initialize: 50 });
  const model = new AcpModel({ agentId: "gemini", leoSessionId: "sess_k3", cwd: () => "/w", manager });
  await assert.rejects(
    collect(model.streamText({ messages: [{ role: "user", content: "hi" }] })),
    /Gemini 卡在握手（initialize）这一步/,
  );
});

test("K: auth method choice follows local login state", () => {
  assert.deepEqual(orderAuthMethods([{ id: "oauth-personal" }, { id: "gemini-api-key" }], ["gemini-api-key"]), [
    "gemini-api-key",
    "oauth-personal",
  ]);
  assert.deepEqual(orderAuthMethods([{ id: "grok.com" }], ["missing"]), ["grok.com"]);
  const home = mkdtempSync(join(tmpdir(), "leo-gem-auth-"));
  assert.deepEqual(geminiAuthPreference({ HOME: home, GEMINI_API_KEY: "k" }), ["gemini-api-key"]);
  assert.deepEqual(geminiAuthPreference({ HOME: home }), ["oauth-personal"]);
  mkdirSync(join(home, ".gemini"));
  writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "vertex-ai" } } }));
  assert.deepEqual(geminiAuthPreference({ HOME: home }), ["vertex-ai"]);
});

test("[fix-remote] L: codex runs the bundled codex-acp with the bundled Node and the newest local codex", async () => {
  const { utimesSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "leo-acp-codex-"));
  const old = makeExecutable(join(home, ".nvm", "versions", "node", "v20.0.0", "bin"), "codex");
  const fresh = makeExecutable(join(home, ".local", "bin"), "codex");
  utimesSync(old, new Date(), new Date(Date.now() + 60_000));
  utimesSync(fresh, new Date(), new Date(Date.now() + 120_000));
  const launch = resolveAcpLaunch("codex", {
    env: { PATH: join(home, ".nvm", "versions", "node", "v20.0.0", "bin"), HOME: home },
    nodePath: "/fake/node",
    resolveCodexAcpEntry: () => "/fake/codex-acp/dist/index.js",
  });
  assert.equal(launch?.command, "/fake/node");
  assert.deepEqual(launch?.args, ["/fake/codex-acp/dist/index.js"]);
  assert.equal(launch?.env.CODEX_PATH, fresh, "PATH 里先排到的旧版 codex 读不了新版 config.toml");
  assert.equal(launch?.env.ELECTRON_RUN_AS_NODE, "1");
});

test("[fix-remote] L: without the bundled adapter, npx is the last resort with a writable temp npm cache", () => {
  const home = mkdtempSync(join(tmpdir(), "leo-acp-npx-"));
  makeExecutable(join(home, "bin"), "codex");
  makeExecutable(join(home, "bin"), "npx");
  const launch = resolveAcpLaunch("codex", {
    env: { PATH: join(home, "bin"), HOME: home },
    resolveCodexAcpEntry: () => undefined,
  });
  assert.match(launch?.command ?? "", /npx$/);
  assert.match(launch?.env.npm_config_cache ?? "", /leobot-npm-cache$/);
});
