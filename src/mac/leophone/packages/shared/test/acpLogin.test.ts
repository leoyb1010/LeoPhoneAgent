import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AcpLoginFlows,
  acpAuthState,
  loginFailureText,
  parseClaudeSetupToken,
  parseCodexLogin,
  parseGrokLogin,
  type AcpLoginFlowView,
} from "../src/acp-login.js";

// [fix-remote] O：外部 agent 远程登录。样例输出是在 Mac 上真实录下的（claude 的 PKCE 参数已换成假值）。
const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const TOKEN = "sk-ant-oat01-TESTTOKENabcdefghijklmnopqrstuvwxyz0123456789_-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefAA";

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "leo-login-"));
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["claude", "grok", "codex"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
  }
  mkdirSync(join(home, ".grok", "bin"), { recursive: true });
  writeFileSync(join(home, ".grok", "bin", "grok"), "#!/bin/sh\n", { mode: 0o755 });
  return { HOME: home, PATH: "/usr/bin", ZCODE_HOME: join(home, ".leophoneagent") };
}

/** 假登录进程：先打印录下的输出；claude 等 stdin 回填后打印令牌。 */
function fakeSpawn(output: string, options: { exitCode?: number; tokenAfterCode?: string } = {}) {
  return () => {
    const script = `
      process.stdout.write(${JSON.stringify(output)});
      ${
        options.tokenAfterCode
          ? `process.stdin.on("data", (d) => { if (String(d).trim() === "THE-CODE") { process.stdout.write("\\r\\nYour OAuth token (valid for 1 year):\\r\\n\\r\\n${options.tokenAfterCode}\\r\\n\\r\\nStore this token securely.\\r\\n"); setTimeout(() => process.exit(0), 50); } else { process.stdout.write("Invalid code\\r\\n"); process.exit(1); } });`
          : `setTimeout(() => process.exit(${options.exitCode ?? 0}), 80);`
      }
    `;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
    return {
      onData: (listener: (chunk: string) => void) => child.stdout.on("data", (d: Buffer) => listener(d.toString())),
      onExit: (listener: (code: number | null) => void) => child.on("exit", (code) => listener(code)),
      write: (data: string) => child.stdin.write(data),
      kill: () => child.kill(),
    };
  };
}

async function until(flows: AcpLoginFlows, id: string, done: (view: AcpLoginFlowView) => boolean) {
  for (let i = 0; i < 200; i += 1) {
    const view = flows.get(id)!;
    if (done(view)) return view;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return flows.get(id)!;
}

describe("login output parsers", () => {
  it("grok --device-auth: url and device code", () => {
    expect(parseGrokLogin(fixture("grok-login-device.txt"))).toEqual({
      url: "https://accounts.x.ai/oauth2/device?user_code=FARH-KCGZ",
      userCode: "FARH-KCGZ",
    });
  });

  it("codex login --device-auth: url and one-time code through ANSI colors", () => {
    expect(parseCodexLogin(fixture("codex-login-device.txt"))).toEqual({
      url: "https://auth.openai.com/codex/device",
      userCode: "1SJ2-SQLOB",
    });
  });

  it("claude setup-token: authorize url out of the OSC 8 hyperlink, then the token", () => {
    const parsed = parseClaudeSetupToken(fixture("claude-setup-token.txt"));
    expect(parsed.url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&client_id=.*&state=FAKESTATE$/);
    expect(parsed.asksForCode).toBe(true);
    expect(parsed.token).toBeUndefined();
    expect(parseClaudeSetupToken(`\u001b[32m${TOKEN}\u001b[0m\r\n`).token).toBe(TOKEN);
  });

  it("failure text never carries a token", () => {
    expect(loginFailureText(`oops ${TOKEN}\r\nError: denied`)).not.toContain("TESTTOKEN");
  });
});

describe("login flows", () => {
  it("grok: device flow → waiting_for_user with url + code → succeeded when the CLI exits 0", async () => {
    const flows = new AcpLoginFlows({ env: fakeHome(), spawnLogin: fakeSpawn(fixture("grok-login-device.txt")) });
    const started = flows.start("grok");
    expect(started.needs_code).toBe(false);
    const waiting = await until(flows, started.flow_id, (v) => v.status !== "starting");
    expect(waiting.user_code).toBe("FARH-KCGZ");
    const done = await until(flows, started.flow_id, (v) => v.status === "succeeded" || v.status === "failed");
    expect(done.status).toBe("succeeded");
  });

  it("codex: a failing CLI ends failed with its last lines", async () => {
    const flows = new AcpLoginFlows({ env: fakeHome(), spawnLogin: fakeSpawn("Error: device code expired\r\n", { exitCode: 1 }) });
    const id = flows.start("codex").flow_id;
    const done = await until(flows, id, (v) => v.status === "failed");
    expect(done.message).toContain("device code expired");
  });

  it("claude: url → code pasted from the phone → token saved 0600 under the data root, never shown", async () => {
    const env = fakeHome();
    const flows = new AcpLoginFlows({
      env,
      spawnLogin: fakeSpawn(fixture("claude-setup-token.txt"), { tokenAfterCode: TOKEN }),
    });
    const id = flows.start("claude-code").flow_id;
    const waiting = await until(flows, id, (v) => v.status === "waiting_for_user");
    expect(waiting.needs_code).toBe(true);
    expect(waiting.code_kind).toBe("auth_code");
    expect(waiting.url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize/);
    await flows.submit(id, "THE-CODE");
    const done = await until(flows, id, (v) => v.status === "succeeded" || v.status === "failed");
    expect(done.status).toBe("succeeded");
    expect(JSON.stringify(done)).not.toContain("TESTTOKEN");
    const file = join(env.ZCODE_HOME, "acp", "claude-oauth-token");
    expect(readFileSync(file, "utf8").trim()).toBe(TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(acpAuthState("claude-code", env)).toMatchObject({ logged_in: true, method: "long-lived-token" });
  });

  it("gemini / opencode: API key paste writes their own files; status follows", async () => {
    const env = fakeHome();
    const flows = new AcpLoginFlows({ env });
    expect(acpAuthState("gemini", env).logged_in).toBe(false);
    const gemini = flows.start("gemini");
    expect(gemini).toMatchObject({ status: "waiting_for_user", needs_code: true, code_kind: "api_key" });
    expect((await flows.submit(gemini.flow_id, "AIzaKEY123"))?.status).toBe("succeeded");
    expect(readFileSync(join(env.HOME, ".gemini", ".env"), "utf8")).toContain("GEMINI_API_KEY=AIzaKEY123");
    expect(acpAuthState("gemini", env)).toMatchObject({ logged_in: true, method: "gemini-api-key" });

    const opencode = flows.start("opencode");
    expect((await flows.submit(opencode.flow_id, "with space"))?.status).toBe("waiting_for_user");
    expect((await flows.submit(opencode.flow_id, "oc-key-123"))?.status).toBe("succeeded");
    const auth = JSON.parse(readFileSync(join(env.HOME, ".local", "share", "opencode", "auth.json"), "utf8"));
    expect(auth.opencode).toEqual({ type: "api", key: "oc-key-123" });
  });

  it("starting again cancels the previous flow; cancel is idempotent", () => {
    const flows = new AcpLoginFlows({ env: fakeHome() });
    const first = flows.start("gemini");
    flows.start("gemini");
    expect(flows.get(first.flow_id)?.status).toBe("cancelled");
    expect(flows.cancel(first.flow_id)?.status).toBe("cancelled");
  });
});
