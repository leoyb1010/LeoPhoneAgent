import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const childProcess = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => childProcess);
vi.mock("@paperclipai/adapter-cursor-local", () => ({ models: [
  { id: "auto", label: "Auto" },
  { id: "claude-opus-5-5", label: "stale invalid base ID" },
] }));
import { listCursorModels, parseCursorModelsOutput, resetCursorModelsCacheForTests, setCursorModelsRunnerForTests } from "../adapters/cursor-models.js";
import { isCursorInvalidModelError } from "../services/cursor-model-configuration.js";
beforeEach(() => resetCursorModelsCacheForTests());
afterEach(() => { setCursorModelsRunnerForTests(null); resetCursorModelsCacheForTests(); });
describe("Cursor model discovery is authoritative", () => {
  it("uses the branded Cursor entrypoint rather than the shared Grok agent name", async () => {
    childProcess.execFile.mockImplementation((_command, _args, _options, callback) => { callback(null, '["auto"]', ""); });
    setCursorModelsRunnerForTests(null);
    expect((await listCursorModels()).map(model => model.id)).toEqual(["auto"]);
    expect(childProcess.execFile).toHaveBeenCalledWith("cursor-agent", ["models"], expect.objectContaining({ timeout: 5000, maxBuffer: 512 * 1024 }), expect.any(Function));
  });
  it("does not merge a stale base model into successfully discovered effort-specific IDs", async () => {
    setCursorModelsRunnerForTests(() => ({ status: 0, stdout: JSON.stringify(["claude-opus-5-5-medium", "claude-opus-5-5-high"]), stderr: "", hasError: false }));
    const models = await listCursorModels();
    expect(models.map(entry => entry.id)).toEqual(["claude-opus-5-5-medium", "claude-opus-5-5-high"]);
  });
  it("offers only safe automatic selection when discovery cannot read this account's catalog", async () => {
    setCursorModelsRunnerForTests(() => ({ status: null, stdout: "", stderr: "", hasError: true }));
    expect((await listCursorModels()).map(entry => entry.id)).toEqual(["auto"]);
  });
  it("merges concurrent callers into one async discovery while allowing the event loop to run", async () => {
    let complete!: (value: { status: number; stdout: string; stderr: string; hasError: boolean }) => void;
    const runner = vi.fn(() => new Promise<{ status: number; stdout: string; stderr: string; hasError: boolean }>(resolve => { complete = resolve; }));
    setCursorModelsRunnerForTests(runner);
    const calls = [listCursorModels(), listCursorModels(), listCursorModels()];
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(runner).toHaveBeenCalledTimes(1);
    complete({ status: 0, stdout: '["claude-opus-5-5-high"]', stderr: "", hasError: false });
    expect(await Promise.all(calls)).toEqual(Array(3).fill([{ id: "claude-opus-5-5-high", label: "claude-opus-5-5-high" }]));
  });
  it("briefly caches timeout/failure auto and retries discovery after the negative TTL", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
    const runner = vi.fn(async () => ({ status: null, stdout: "", stderr: "", hasError: true }));
    setCursorModelsRunnerForTests(runner);
    await listCursorModels(); await listCursorModels();
    expect(runner).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(105_001);
    await listCursorModels(); expect(runner).toHaveBeenCalledTimes(2);
    clock.mockRestore();
  });
  it("handles a rejected async discovery without advertising stale vendor IDs", async () => {
    setCursorModelsRunnerForTests(async () => { throw new Error("timed out"); });
    expect((await listCursorModels()).map(entry => entry.id)).toEqual(["auto"]);
  });
  it("keeps exact effort and fast model IDs from an available-model diagnostic", () => {
    expect(parseCursorModelsOutput("", "Available models: claude-opus-5-5-high, claude-opus-5-5-high-fast").map(entry => entry.id)).toEqual(["claude-opus-5-5-high", "claude-opus-5-5-high-fast"]);
  });
});
describe("Cursor invalid-model configuration errors", () => {
  it("recognizes the observed rejection without interpreting task output or other adapters", () => {
    expect(isCursorInvalidModelError("cursor", "Cannot use this model: claude-opus-5-5. Available models: claude-opus-5-5-high")).toBe(true);
    expect(isCursorInvalidModelError("cursor", "Error: Cannot use this model: unsupported")).toBe(true);
    expect(isCursorInvalidModelError("opencode_local", "Cannot use this model: unsupported")).toBe(false);
    expect(isCursorInvalidModelError("cursor", "The user said Cannot use this model: a")).toBe(false);
  });
  it.each(["Connection reset", "Rate limit exceeded", "Unauthorized", "Tool failed", null])("does not convert %s into a permanent model error", message => {
    expect(isCursorInvalidModelError("cursor", message)).toBe(false);
  });
});
