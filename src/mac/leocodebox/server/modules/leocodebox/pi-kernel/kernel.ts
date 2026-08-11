/**
 * pi 自有内核 v0 — leocodebox's own in-process agent runtime.
 *
 * A minimal but REAL agent loop (the fusion of pi's `pi-agent-core`): drive a
 * model through the Anthropic tool-use protocol, execute the tool calls it
 * asks for, feed results back, and repeat until the model stops or a step cap
 * is hit. It does NOT depend on the external claude/codex CLIs — this is the
 * app owning its own agent control.
 *
 * Everything the loop needs from the outside (the model call, the tool
 * executor) is INJECTED, so the control flow is pure and unit-testable without
 * a network or a filesystem. The real model call lives in kernel-client.ts and
 * the real tools in kernel-tools.ts.
 */

export type ToolSpec = { name: string; description: string; input_schema: Record<string, unknown> };
export type ToolResult = { content: string; isError?: boolean };
export type ToolExecutor = (name: string, input: Record<string, unknown>) => Promise<ToolResult>;

export type ModelBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ModelTurn = { blocks: ModelBlock[]; stopReason: string | null };
export type KernelMessage = { role: 'user' | 'assistant'; content: unknown };
export type CallModel = (messages: KernelMessage[]) => Promise<ModelTurn>;

export type KernelEvent =
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_call'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; content: string; isError: boolean }
  | { type: 'done'; steps: number }
  | { type: 'aborted'; reason: 'max_steps'; steps: number };

export type KernelRun = { events: KernelEvent[]; finalText: string; steps: number; aborted: boolean };

const DEFAULT_MAX_STEPS = 12;

/** Concatenate the text blocks of one model turn. */
function textOf(turn: ModelTurn): string {
  return turn.blocks.filter((b): b is Extract<ModelBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('');
}

/**
 * Run one agent task to completion. Returns the full event transcript, the
 * final assistant text, the number of model round-trips, and whether it hit the
 * step cap. Never throws for tool failures — a throwing/unknown tool becomes an
 * `isError` tool_result the model can react to (exactly like a real tool error).
 */
export async function runKernelTask(opts: {
  prompt: string;
  tools: ToolSpec[];
  callModel: CallModel;
  executeTool: ToolExecutor;
  maxSteps?: number;
}): Promise<KernelRun> {
  const maxSteps = Math.max(1, Math.min(40, opts.maxSteps ?? DEFAULT_MAX_STEPS));
  const events: KernelEvent[] = [];
  const messages: KernelMessage[] = [{ role: 'user', content: opts.prompt }];
  let finalText = '';

  for (let step = 1; step <= maxSteps; step += 1) {
    const turn = await opts.callModel(messages);
    const text = textOf(turn);
    if (text) events.push({ type: 'assistant_text', text });

    // Record the assistant turn verbatim so the next model call sees real history.
    messages.push({ role: 'assistant', content: turn.blocks });

    const toolUses = turn.blocks.filter((b): b is Extract<ModelBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    if (toolUses.length === 0 || turn.stopReason === 'end_turn') {
      finalText = text || finalText;
      events.push({ type: 'done', steps: step });
      return { events, finalText, steps: step, aborted: false };
    }

    // Execute each requested tool and feed the results back as a user turn.
    const resultBlocks: Array<Record<string, unknown>> = [];
    for (const call of toolUses) {
      events.push({ type: 'tool_call', name: call.name, input: call.input });
      let result: ToolResult;
      try {
        result = await opts.executeTool(call.name, call.input);
      } catch (error) {
        result = { content: error instanceof Error ? error.message : 'tool execution failed', isError: true };
      }
      events.push({ type: 'tool_result', name: call.name, content: result.content, isError: Boolean(result.isError) });
      resultBlocks.push({ type: 'tool_result', tool_use_id: call.id, content: result.content, is_error: Boolean(result.isError) });
    }
    messages.push({ role: 'user', content: resultBlocks });
    finalText = text || finalText;
  }

  events.push({ type: 'aborted', reason: 'max_steps', steps: maxSteps });
  return { events, finalText, steps: maxSteps, aborted: true };
}
