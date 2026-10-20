// @vitest-environment jsdom
// [leo][WP-21] 外部 agent 会话的 `/` 面板：列 agent 自带命令（CLI 落盘、主进程读），选中后 `/名字` 原样发出。
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acpAgentIdOf, toAcpSlashCommands, useLeoAcpSlashCommands } from "../src/leo/useLeoAcpSlashCommands.js";
import { buildSlashApplyMentionPayload } from "../src/lib/slashApplyMentionPayload.js";
import { buildSlashSuggestions } from "../src/slashCommandHelpers.js";

afterEach(() => {
  delete (window as unknown as { leoAcp?: unknown }).leoAcp;
  vi.useRealTimers();
});

describe("ACP agent slash commands", () => {
  it("only ACP selections with a known agent count as external-agent sessions", () => {
    expect(acpAgentIdOf({ provider: "acp", model: "claude-code" })).toBe("claude-code");
    expect(acpAgentIdOf({ provider: "acp", model: "bogus" })).toBeNull();
    expect(acpAgentIdOf({ provider: "openai", model: "gpt-5" })).toBeNull();
    expect(acpAgentIdOf(null)).toBeNull();
  });

  it("agent commands become / suggestions that insert /name for the agent to run", () => {
    const commands = toAcpSlashCommands([
      { name: "review", description: "Review the diff", inputHint: "/review [focus]" },
      { name: "/init", description: "Write CLAUDE.md" },
      { name: "review", description: "duplicate" },
    ]);
    expect(commands.map((command) => command.name)).toEqual(["review", "init"]);
    const suggestions = buildSlashSuggestions(commands);
    expect(suggestions.map((item) => item.label)).toEqual(["/review [focus]", "/init"]);
    expect(buildSlashApplyMentionPayload(suggestions[0]!).markdown).toBe("/review");
  });

  it("hook reads the agent's commands for this workspace and stays undefined for LeoBot sessions", async () => {
    const commands = vi.fn(async () => [{ name: "review", description: "Review the diff" }]);
    (window as unknown as { leoAcp?: unknown }).leoAcp = { commands };

    const leo = renderHook(() => useLeoAcpSlashCommands(null, "/repo"));
    expect(leo.result.current).toBeUndefined();
    expect(commands).not.toHaveBeenCalled();

    const acp = renderHook(() => useLeoAcpSlashCommands("claude-code", "/repo"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(commands).toHaveBeenCalledWith("claude-code", "/repo");
    expect(acp.result.current?.map((command) => command.name)).toEqual(["review"]);
    acp.unmount();
  });

  it("polling the same commands keeps the same array (no re-render of the session pane)", async () => {
    const commands = vi.fn(async () => [{ name: "review", description: "Review the diff" }]);
    (window as unknown as { leoAcp?: unknown }).leoAcp = { commands };
    let renders = 0;
    const acp = renderHook(() => {
      renders += 1;
      return useLeoAcpSlashCommands("claude-code", "/repo");
    });
    await act(async () => {
      await Promise.resolve();
    });
    const first = acp.result.current;
    const rendersAfterLoad = renders;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(commands).toHaveBeenCalledTimes(2);
    expect(acp.result.current).toBe(first);
    expect(renders).toBe(rendersAfterLoad);
    acp.unmount();
  });
});
