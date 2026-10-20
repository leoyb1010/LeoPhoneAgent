// [leo][WP-21] ACP 客户端：用 SDK 的 AgentSideConnection 起一个假 agent，回放一轮
// 「说话 → 要授权的编辑 → 无需授权的命令 → 计划 → 收尾」，验证模型流与审批回路。
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type PromptRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { ModelEvent, ModelInputMessage } from "@zcode/contracts";
import {
  ACP_TOOL_NAME,
  parseAcpCommandsStore,
  pickAcpAgentCommands,
  type AcpToolCallInput,
} from "@zcode/shared/acp";
import { AcpModel } from "../../src/acp/model.js";
import { AcpSessionManager } from "../../src/acp/manager.js";
import { connectAcpStream, type ConnectAcpAgentOptions } from "../../src/acp/process.js";

type Script = (conn: AgentSideConnection, params: PromptRequest) => Promise<void>;

function pipePair() {
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  return {
    clientStream: ndJsonStream(toAgent.writable, toClient.readable),
    agentStream: ndJsonStream(toClient.writable, toAgent.readable),
  };
}

function fakeConnect(script: Script, seen: { prompts: PromptRequest[]; permissions: RequestPermissionResponse[]; cancelled: number }) {
  return async (_launch: unknown, options: ConnectAcpAgentOptions) => {
    const { clientStream, agentStream } = pipePair();
    let conn!: AgentSideConnection;
    const agent: Agent = {
      initialize: async () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
      }),
      newSession: async () => ({ sessionId: "acp-session-1" }),
      authenticate: async () => ({}),
      prompt: async (params) => {
        seen.prompts.push(params);
        await script(conn, params);
        return { stopReason: "end_turn" };
      },
      cancel: async () => {
        seen.cancelled += 1;
      },
    };
    conn = new AgentSideConnection(() => agent, agentStream);
    return connectAcpStream(clientStream, options);
  };
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function textOf(events: readonly ModelEvent[]): string {
  return events.map((event) => (event.type === "text_delta" ? event.text : "")).join("");
}

function toolCalls(events: readonly ModelEvent[]) {
  return events.flatMap((event) => (event.type === "tool_call" ? [event.toolCall] : []));
}

const user = (text: string): ModelInputMessage => ({ role: "user", content: text });

/** 一个只有假 claude 可执行文件的环境（不依赖开发机是否装了 Claude Code）。 */
function fakeClaudeEnvironment() {
  const home = mkdtempSync(join(tmpdir(), "leo-acp-test-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "claude"), 0o755);
  return {
    env: { PATH: bin, HOME: home },
    resolveClaudeAgentAcpEntry: () => "/fake/claude-agent-acp.js",
  };
}

test("ACP turn: text, approved edit, auto command, plan, then stop", async () => {
  const seen = { prompts: [] as PromptRequest[], permissions: [] as RequestPermissionResponse[], cancelled: 0 };
  const script: Script = async (conn, params) => {
    const sessionId = params.sessionId;
    await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "我来改一下。" } } });
    await conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t-edit",
        title: "Edit a.txt",
        kind: "edit",
        status: "pending",
        content: [{ type: "diff", path: "/w/a.txt", oldText: "a", newText: "b" }],
        locations: [{ path: "/w/a.txt" }],
      },
    });
    const decision = await conn.requestPermission({
      sessionId,
      toolCall: { toolCallId: "t-edit" },
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });
    seen.permissions.push(decision);
    await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "t-edit", status: "completed" } });
    await conn.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "t-ls", title: "ls", kind: "execute", status: "in_progress", rawInput: { command: "ls -la" } },
    });
    await conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "t-ls",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "a.txt" } }],
      },
    });
    await conn.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "plan", entries: [{ content: "改 a.txt", priority: "high", status: "completed" }] },
    });
    await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "改好了。" } } });
  };
  const manager = new AcpSessionManager({
    connect: fakeConnect(script, seen) as never,
    statePath: "/dev/null/acp-sessions.json",
    environment: fakeClaudeEnvironment(),
  });
  const model = new AcpModel({ agentId: "claude-code", leoSessionId: "sess_1", cwd: () => "/w", manager });

  // 第 1 步：新用户消息 → 先说话，再交出需要审批的编辑
  const step1 = await collect(model.streamText({ messages: [user("把 a 改成 b")] }));
  assert.equal(textOf(step1), "我来改一下。");
  const [edit] = toolCalls(step1);
  assert.equal(edit?.name, ACP_TOOL_NAME);
  const editInput = edit!.input as AcpToolCallInput;
  assert.equal(editInput.needsApproval, true);
  assert.equal(editInput.kind, "edit");
  assert.deepEqual(editInput.diff, { path: "/w/a.txt", oldText: "a", newText: "b" });
  assert.equal(step1.at(-1)?.type, "finish");
  assert.equal(seen.prompts[0]?.prompt[0]?.type, "text");

  // 运行时批准 → handler 回复 agent 的授权并等这步完成
  const host = manager.host("sess_1")!;
  const editOutput = await host.runApprovedTool(edit!.id, editInput.acpToolCallId);
  assert.equal(seen.permissions[0]?.outcome.outcome, "selected");
  assert.equal(seen.permissions[0]?.outcome.outcome === "selected" && seen.permissions[0].outcome.optionId, "yes");
  assert.equal(editOutput.status, "completed");
  assert.equal(editOutput.diffs?.[0]?.newText, "b");

  // 第 2 步：工具结果回填 → 无需授权的命令
  const continuation: ModelInputMessage[] = [
    user("把 a 改成 b"),
    { role: "assistant", content: "我来改一下。", toolCalls: [edit!] },
    { role: "tool", content: "ok", toolCallId: edit!.id, toolName: ACP_TOOL_NAME },
  ];
  const step2 = await collect(model.streamText({ messages: continuation }));
  const [ls] = toolCalls(step2);
  const lsInput = ls!.input as AcpToolCallInput;
  assert.equal(lsInput.needsApproval, false);
  assert.equal(lsInput.command, "ls -la");
  const lsOutput = await host.runApprovedTool(ls!.id, lsInput.acpToolCallId);
  assert.equal(lsOutput.text, "a.txt");

  // 第 3 步：计划翻成 TodoWrite
  const step3 = await collect(model.streamText({ messages: continuation }));
  const [plan] = toolCalls(step3);
  assert.equal(plan?.name, "TodoWrite");
  assert.deepEqual(plan?.input, { todos: [{ content: "改 a.txt", status: "completed", priority: "high" }] });

  // 第 4 步：收尾
  const step4 = await collect(model.streamText({ messages: continuation }));
  assert.equal(textOf(step4), "改好了。");
  const finish = step4.at(-1);
  assert.equal(finish?.type, "finish");
  assert.equal(finish?.type === "finish" && finish.finishReason, "stop");
  manager.disposeAll();
});

test("ACP turn: a denied approval is rejected back to the agent", async () => {
  const seen = { prompts: [] as PromptRequest[], permissions: [] as RequestPermissionResponse[], cancelled: 0 };
  const script: Script = async (conn, params) => {
    const sessionId = params.sessionId;
    await conn.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "t-rm", title: "rm -rf build", kind: "delete", status: "pending", rawInput: { command: "rm -rf build" } },
    });
    seen.permissions.push(
      await conn.requestPermission({
        sessionId,
        toolCall: { toolCallId: "t-rm" },
        options: [
          { optionId: "ok", name: "Allow", kind: "allow_once" },
          { optionId: "nope", name: "Reject", kind: "reject_once" },
        ],
      }),
    );
    await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "好的，不删。" } } });
  };
  const manager = new AcpSessionManager({
    connect: fakeConnect(script, seen) as never,
    statePath: "/dev/null/acp-sessions.json",
    environment: fakeClaudeEnvironment(),
  });
  const model = new AcpModel({ agentId: "claude-code", leoSessionId: "sess_2", cwd: () => "/w", manager });
  const step1 = await collect(model.streamText({ messages: [user("清理 build")] }));
  const [rm] = toolCalls(step1);
  assert.equal((rm!.input as AcpToolCallInput).needsApproval, true);

  // 运行时拒绝：handler 不跑，工具结果是错误；下一次模型请求把授权拒绝回去
  const step2 = await collect(
    model.streamText({
      messages: [
        user("清理 build"),
        { role: "assistant", content: "", toolCalls: [rm!] },
        { role: "tool", content: "User denied", toolCallId: rm!.id, toolName: ACP_TOOL_NAME, isError: true },
      ],
    }),
  );
  const decision = seen.permissions[0]?.outcome;
  assert.equal(decision?.outcome === "selected" && decision.optionId, "nope");
  assert.equal(textOf(step2), "好的，不删。");
  manager.disposeAll();
});

test("ACP model refuses cleanly when the agent is not installed", async () => {
  const manager = new AcpSessionManager({
    statePath: "/dev/null/acp-sessions.json",
    environment: { env: { PATH: "/nonexistent", HOME: "/nonexistent" } },
  });
  const model = new AcpModel({ agentId: "gemini", leoSessionId: "sess_3", cwd: () => "/w", manager });
  await assert.rejects(collect(model.streamText({ messages: [user("hi")] })), /Gemini 在这台 Mac 上不可用/);
});

test("Claude Code ordering: empty pending call, diff later, then permission → one approval card", async () => {
  const seen = { prompts: [] as PromptRequest[], permissions: [] as RequestPermissionResponse[], cancelled: 0 };
  const script: Script = async (conn, params) => {
    const sessionId = params.sessionId;
    await conn.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "t-w", title: "Preparing file…", kind: "edit", status: "pending", content: [] },
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    await conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "t-w",
        title: "Write hello.txt",
        content: [{ type: "diff", path: "/w/hello.txt", oldText: null, newText: "hi" }],
      },
    });
    seen.permissions.push(
      await conn.requestPermission({
        sessionId,
        toolCall: { toolCallId: "t-w" },
        options: [{ optionId: "y", name: "Allow", kind: "allow_once" }],
      }),
    );
    await conn.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "t-w", status: "completed" } });
  };
  const manager = new AcpSessionManager({
    connect: fakeConnect(script, seen) as never,
    statePath: "/dev/null/acp-sessions.json",
    environment: fakeClaudeEnvironment(),
  });
  const model = new AcpModel({ agentId: "claude-code", leoSessionId: "sess_4", cwd: () => "/w", manager });
  const step1 = await collect(model.streamText({ messages: [user("写 hello")] }));
  const calls = toolCalls(step1);
  assert.equal(calls.length, 1);
  const input = calls[0]!.input as AcpToolCallInput;
  assert.equal(input.needsApproval, true);
  assert.equal(input.title, "Write hello.txt");
  assert.equal(input.diff?.newText, "hi");
  const output = await manager.host("sess_4")!.runApprovedTool(calls[0]!.id, input.acpToolCallId);
  assert.equal(output.status, "completed");
  manager.disposeAll();
});

test("available_commands_update: agent commands are recorded per agent + cwd for the / panel; the prompt goes through verbatim", async () => {
  const seen = { prompts: [] as PromptRequest[], permissions: [] as RequestPermissionResponse[], cancelled: 0 };
  const script: Script = async (conn, params) => {
    await conn.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "review", description: "Review the current diff", input: { hint: "[focus]" } },
          { name: "init", description: "Write CLAUDE.md" },
        ],
      },
    });
    await conn.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reviewed" } },
    });
  };
  const dir = mkdtempSync(join(tmpdir(), "leo-acp-commands-"));
  const manager = new AcpSessionManager({
    connect: fakeConnect(script, seen) as never,
    statePath: join(dir, "acp-sessions.json"),
    environment: fakeClaudeEnvironment(),
  });
  const model = new AcpModel({ agentId: "claude-code", leoSessionId: "sess_cmd", cwd: () => "/w/repo", manager });
  const events = await collect(model.streamText({ messages: [user("/review tests only")] }));
  assert.equal(textOf(events), "reviewed");
  // 斜杠命令原样作为 prompt 交给 agent（由 agent 自己执行）。
  const promptText = seen.prompts[0]!.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
  assert.equal(promptText, "/review tests only");

  const store = parseAcpCommandsStore(JSON.parse(readFileSync(join(dir, "acp-commands.json"), "utf8")));
  assert.deepEqual(pickAcpAgentCommands(store, "claude-code", "/w/repo"), [
    { name: "review", description: "Review the current diff", inputHint: "/review [focus]" },
    { name: "init", description: "Write CLAUDE.md" },
  ]);
  // 没开过会话的目录退回该 agent 最近一次的命令表；别的 agent 没有。
  assert.equal(pickAcpAgentCommands(store, "claude-code", "/elsewhere").length, 2);
  assert.deepEqual(pickAcpAgentCommands(store, "codex", "/w/repo"), []);
  assert.deepEqual(
    manager.host("sess_cmd")!.availableCommands.map((command) => command.name),
    ["review", "init"],
  );
  manager.disposeAll();
});
