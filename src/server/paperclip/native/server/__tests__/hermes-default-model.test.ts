import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@paperclipai/adapter-utils/server-utils", async importOriginal => {
  const original = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return { ...original, runChildProcess: vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" })) };
});
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (file: unknown) => String(file).endsWith("config.yaml") ? "model:\n  default: gemini-3.8-flash-high\n  provider: leostudio\n  base_url: https://gateway.example.invalid\n  api_mode: chat_completions\n" : ""),
  writeFile: vi.fn(async () => undefined), mkdir: vi.fn(async () => undefined), rm: vi.fn(async () => undefined), access: vi.fn(async () => undefined), readdir: vi.fn(async () => []), stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));
import { execute } from "../../../packages/adapters/hermes/src/server/execute.js";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
function context(config: Record<string, unknown>) {
  return { runId: "fixture", agent: { id: "fixture-agent", companyId: "fixture-company", name: "Fixture Hermes", adapterType: "hermes_local", adapterConfig: config }, runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null }, config: { command: "/fixture/hermes", timeoutSec: 60, graceSec: 1, ...config }, context: { issueId: "fixture-issue" }, onLog: vi.fn(async () => undefined), onMeta: vi.fn(async () => undefined) };
}
beforeEach(() => vi.clearAllMocks());
describe("Hermes local CLI retains configured defaults", () => {
  it.each([undefined, "", "auto"])("does not override the server's configured model with %s", async model => {
    await execute(context({ model }) as never);
    const args = vi.mocked(runChildProcess).mock.calls.at(-1)![2];
    expect(args).not.toContain("-m"); expect(args).not.toContain("auto"); expect(args).not.toContain("--provider");
  });
  it("passes an explicit model exactly and preserves the existing custom CLI provider", async () => {
    await execute(context({ model: "gemini-3.8-flash-high" }) as never);
    const args = vi.mocked(runChildProcess).mock.calls.at(-1)![2];
    const index = args.indexOf("-m"); expect(index).toBeGreaterThan(-1); expect(args[index + 1]).toBe("gemini-3.8-flash-high"); expect(args).not.toContain("--provider");
  });
  it("still honors an explicitly supported provider override", async () => {
    await execute(context({ model: "claude-sonnet-5", provider: "anthropic" }) as never);
    const args = vi.mocked(runChildProcess).mock.calls.at(-1)![2];
    const index = args.indexOf("--provider"); expect(index).toBeGreaterThan(-1); expect(args[index + 1]).toBe("anthropic");
  });
});
