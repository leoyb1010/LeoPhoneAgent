import crypto from 'node:crypto';

// 方言翻译层——把每个编码 CLI 各自的 JSON 协议翻成一套事件词汇表,与
// leoagent(Python 版 harness.py)逐帧对齐:手机端已经在渲染这套词汇,
// 服务端换了宿主(leocodebox)之后事件形状必须一个字段都不差。
//
// 设计沿袭原版:只归一化"事件信封",绝不做厂商 API 之间的转译;每个 CLI
// 继续对自己的后端说自己的协议。

export const EVENT_MESSAGE_DELTA = 'message.delta';
export const EVENT_REASONING = 'reasoning.available';
export const EVENT_TOOL_STARTED = 'tool.started';
export const EVENT_TOOL_COMPLETED = 'tool.completed';
export const EVENT_APPROVAL_REQUEST = 'approval.request';
export const EVENT_APPROVAL_RESPONDED = 'approval.responded';
export const EVENT_USER_MESSAGE = 'user.message';
export const EVENT_SESSION_CREATED = 'session.created';
export const EVENT_RUN_COMPLETED = 'run.completed';
export const EVENT_RUN_FAILED = 'run.failed';
export const EVENT_RUN_CANCELLED = 'run.cancelled';

export type HarnessEvent = { event: string } & Record<string, unknown>;

type JsonObject = Record<string, unknown>;

export interface DialectResult {
  events: HarnessEvent[];
  /** translator 排给 stdin 的帧(排队输入的补发、对不支持请求的拒绝响应)。 */
  outFrames: unknown[];
}

/** 用户输入在各方言下的去向:立即可写的帧,或"会话 id 未就绪,已排队"。 */
export type UserMessageResult = { frames: unknown[] } | { queued: true };

export interface HarnessDialect {
  /** 启动后立即写入 stdin 的帧(JSON-RPC 类方言的握手)。 */
  handshake(): unknown[];
  /** 一行 stdout(已解析为 JSON)→ 事件 + 待写帧。 */
  translateLine(obj: JsonObject): DialectResult;
  /** 用户消息 → 帧或排队。 */
  userMessage(text: string): UserMessageResult;
  /**
   * 审批答复 → CLI 自己方言的帧;null 表示无法送达(缺 request_id 等),
   * 调用方必须保持审批 pending 而不是假装已解决。
   */
  approvalPayload(pending: JsonObject, choice: string): unknown | null;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function choiceAllowed(choice: string): boolean {
  // 默认拒绝:未识别的标签绝不能读作同意。
  return ['once', 'always', 'yes', 'approve', 'allow'].includes(choice);
}

// --------------------------------------------------------------------------
// Claude Code — stream-json
// --------------------------------------------------------------------------

export class ClaudeStreamJsonDialect implements HarnessDialect {
  handshake(): unknown[] {
    return [];
  }

  translateLine(obj: JsonObject): DialectResult {
    const out: HarnessEvent[] = [];
    const kind = obj.type;

    if (kind === 'assistant') {
      for (const raw of asArray(asObject(obj.message).content)) {
        const block = asObject(raw);
        if (block.type === 'text' && block.text) {
          out.push({ event: EVENT_MESSAGE_DELTA, delta: block.text });
        } else if (block.type === 'thinking' && block.thinking) {
          out.push({ event: EVENT_REASONING, text: block.thinking });
        } else if (block.type === 'tool_use') {
          const preview = JSON.stringify(asObject(block.input));
          out.push({
            event: EVENT_TOOL_STARTED,
            tool: block.name || 'tool',
            preview: preview.slice(0, 200),
            tool_use_id: block.id,
          });
        }
      }
    } else if (kind === 'user') {
      // 工具结果以 user 角色回来。
      for (const raw of asArray(asObject(obj.message).content)) {
        const block = asObject(raw);
        if (block.type === 'tool_result') {
          out.push({
            event: EVENT_TOOL_COMPLETED,
            tool: 'tool',
            error: Boolean(block.is_error),
            tool_use_id: block.tool_use_id,
          });
        }
      }
    } else if (kind === 'result') {
      if (obj.is_error) {
        out.push({ event: EVENT_RUN_FAILED, error: obj.result || 'failed' });
      } else {
        out.push({ event: EVENT_RUN_COMPLETED, output: obj.result || '', usage: obj.usage || {} });
      }
    } else if (kind === 'control_request') {
      // 只有 can_use_tool 是审批;其余子类型(hook_callback/mcp_message…)
      // 原样透传,当权限来答会弄坏控制协议。
      const req = asObject(obj.request);
      if (req.subtype === 'can_use_tool' || 'tool_name' in req || 'command' in req) {
        const detail = req.input;
        const description = str(req.description)
          || (detail != null ? JSON.stringify(detail).slice(0, 300) : '');
        out.push({
          event: EVENT_APPROVAL_REQUEST,
          command: str(req.tool_name || req.command),
          description,
          choices: ['once', 'always', 'deny'],
          request_id: obj.request_id,
          raw: req,
        });
      } else {
        out.push({ event: 'harness.control_request', raw: obj });
      }
    }

    if (out.length === 0 && kind) {
      out.push({ event: `harness.${str(kind)}`, raw: obj });
    }
    return { events: out, outFrames: [] };
  }

  userMessage(text: string): UserMessageResult {
    return {
      frames: [{
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      }],
    };
  }

  approvalPayload(pending: JsonObject, choice: string): unknown | null {
    const requestId = pending.request_id;
    if (requestId == null) return null;
    const allowed = choiceAllowed(choice);
    // Agent-SDK 控制协议形状:subtype + request_id 包在响应信封里;扁平
    // 形状会被 CLI 静默忽略——审批永远落不了地。
    const inner: JsonObject = { behavior: allowed ? 'allow' : 'deny' };
    if (!allowed) {
      inner.message = 'denied by operator';
    } else if (choice === 'always') {
      const suggestions = asObject(pending.raw).permission_suggestions;
      if (suggestions) inner.updatedPermissions = suggestions;
    }
    return {
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: inner },
    };
  }
}

// --------------------------------------------------------------------------
// pi — RPC
// --------------------------------------------------------------------------

export class PiRpcDialect implements HarnessDialect {
  handshake(): unknown[] {
    return [];
  }

  translateLine(obj: JsonObject): DialectResult {
    const out: HarnessEvent[] = [];
    const kind = obj.type;

    if (kind === 'message_update') {
      const ev = asObject(obj.assistantMessageEvent);
      if (ev.type === 'text_delta' && ev.delta) {
        out.push({ event: EVENT_MESSAGE_DELTA, delta: ev.delta });
      } else if (ev.type === 'thinking_delta' && ev.delta) {
        out.push({ event: EVENT_REASONING, text: ev.delta });
      }
    } else if (kind === 'tool_execution_start') {
      out.push({
        event: EVENT_TOOL_STARTED,
        tool: obj.toolName || 'tool',
        preview: JSON.stringify(asObject(obj.args)).slice(0, 200),
      });
    } else if (kind === 'tool_execution_end') {
      out.push({
        event: EVENT_TOOL_COMPLETED,
        tool: obj.toolName || 'tool',
        error: Boolean(obj.isError),
      });
    } else if (kind === 'extension_ui_request') {
      // pi 会阻塞等这些,所以在我们的词汇里正是审批。
      if (obj.method === 'confirm' || obj.method === 'select') {
        out.push({
          event: EVENT_APPROVAL_REQUEST,
          command: str(obj.message),
          description: '',
          choices: asArray(obj.choices).length > 0 ? obj.choices : ['once', 'deny'],
          request_id: obj.id,
          raw: obj,
        });
      }
    } else if (kind === 'turn_end' || kind === 'response') {
      out.push({ event: EVENT_RUN_COMPLETED, output: obj.text || '', usage: {} });
    }

    if (out.length === 0 && kind) {
      out.push({ event: `harness.${str(kind)}`, raw: obj });
    }
    return { events: out, outFrames: [] };
  }

  userMessage(text: string): UserMessageResult {
    return { frames: [{ id: crypto.randomUUID(), type: 'prompt', message: text }] };
  }

  approvalPayload(pending: JsonObject, choice: string): unknown | null {
    const requestId = pending.request_id;
    if (requestId == null) return null;
    // `select` 提示带自己的标签且要求原样返回;`confirm` 要布尔值。
    const cliChoices = asArray(asObject(pending.raw).choices).map(str);
    const result: unknown = cliChoices.includes(choice) ? choice : choiceAllowed(choice);
    return { id: requestId, type: 'extension_ui_response', result };
  }
}

// --------------------------------------------------------------------------
// Codex CLI — app-server(JSON-RPC 2.0 over stdio)
// --------------------------------------------------------------------------

export class CodexAppServerDialect implements HarnessDialect {
  private rpcSeq = 100;
  private threadId: string | null = null;
  private pendingInputs: string[] = [];

  constructor(private readonly cwd: string) {}

  private nextRpcId(): number {
    this.rpcSeq += 1;
    return this.rpcSeq;
  }

  private turnStartFrame(text: string): JsonObject {
    return {
      jsonrpc: '2.0', id: this.nextRpcId(), method: 'turn/start',
      params: { threadId: this.threadId, input: [{ type: 'text', text }] },
    };
  }

  handshake(): unknown[] {
    return [
      { jsonrpc: '2.0', id: this.nextRpcId(), method: 'initialize',
        params: { clientInfo: { name: 'leoagent', version: '0.2.0' } } },
      { jsonrpc: '2.0', id: this.nextRpcId(), method: 'thread/start',
        params: { cwd: this.cwd } },
    ];
  }

  /** threadId 就绪时把排队的输入变成待写帧。 */
  private captureThread(threadId: unknown, outFrames: unknown[]): void {
    if (threadId && !this.threadId) {
      this.threadId = String(threadId);
      for (const queued of this.pendingInputs) {
        outFrames.push(this.turnStartFrame(queued));
      }
      this.pendingInputs = [];
    }
  }

  translateLine(obj: JsonObject): DialectResult {
    const out: HarnessEvent[] = [];
    const outFrames: unknown[] = [];
    const method = obj.method;
    const params = asObject(obj.params);

    if (method == null) {
      // 我们发出的请求的响应
      const result = asObject(obj.result);
      this.captureThread(result.threadId ?? asObject(result.thread).id, outFrames);
      if (obj.error) {
        out.push({ event: 'harness.stderr',
          text: `rpc error: ${JSON.stringify(obj.error).slice(0, 200)}` });
      }
      return { events: out, outFrames };
    }

    if ('id' in obj) {
      // server→client 请求。审批类转审批;其余礼貌拒绝,免得对端挂等。
      if (method === 'item/commandExecution/requestApproval'
        || method === 'item/fileChange/requestApproval'
        || method === 'item/permissions/requestApproval') {
        const item = asObject(params.item);
        const command = item.command ?? params.reason ?? String(method).split('/')[1];
        out.push({
          event: EVENT_APPROVAL_REQUEST,
          command: str(command).slice(0, 300),
          description: str(params.reason),
          choices: ['once', 'always', 'deny'],
          request_id: obj.id,
          raw: params,
        });
      } else {
        outFrames.push({ jsonrpc: '2.0', id: obj.id,
          error: { code: -32601, message: `unsupported: ${str(method)}` } });
        out.push({ event: 'harness.control_request', raw: { method } });
      }
      return { events: out, outFrames };
    }

    // 通知
    if (method === 'thread/started') {
      this.captureThread(params.threadId ?? asObject(params.thread).id, outFrames);
    } else if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      if (params.delta) out.push({ event: EVENT_REASONING, text: params.delta });
    } else if (method === 'item/started' || method === 'item/updated' || method === 'item/completed') {
      const item = asObject(params.item);
      const itemType = item.type;
      const itemId = item.id;
      if (itemType === 'agentMessage' && method === 'item/completed') {
        if (item.text) out.push({ event: EVENT_MESSAGE_DELTA, delta: item.text });
      } else if (itemType === 'commandExecution') {
        if (method === 'item/started') {
          out.push({ event: EVENT_TOOL_STARTED, tool: 'exec',
            preview: str(item.command).slice(0, 200), tool_use_id: itemId });
        } else if (method === 'item/completed') {
          out.push({ event: EVENT_TOOL_COMPLETED, tool: 'exec',
            error: Boolean(item.exitCode), tool_use_id: itemId });
        }
      } else if (itemType === 'fileChange' && method === 'item/completed') {
        out.push({ event: EVENT_TOOL_COMPLETED, tool: 'edit', error: false, tool_use_id: itemId });
      }
    } else if (method === 'turn/completed') {
      out.push({ event: EVENT_RUN_COMPLETED, output: '', usage: {} });
    } else if (method === 'error') {
      out.push({ event: EVENT_RUN_FAILED, error: str(params.message) || 'error' });
    }
    // 其余通知(status/tokenUsage/…)不进转录,保持日志干净
    return { events: out, outFrames };
  }

  userMessage(text: string): UserMessageResult {
    if (this.threadId) return { frames: [this.turnStartFrame(text)] };
    this.pendingInputs.push(text);
    return { queued: true };
  }

  approvalPayload(pending: JsonObject, choice: string): unknown | null {
    const requestId = pending.request_id;
    if (requestId == null) return null;
    const decisions: Record<string, string> = { once: 'accept', always: 'acceptForSession', deny: 'decline' };
    return { jsonrpc: '2.0', id: requestId, result: { decision: decisions[choice] ?? 'decline' } };
  }
}

// --------------------------------------------------------------------------
// Grok CLI — ACP(Agent Client Protocol over stdio)
// 实测帧型(grok 0.2.118):session/new 响应带 result.sessionId;流式更新是
// session/update 通知;审批是 server→client 请求 session/request_permission。
// --------------------------------------------------------------------------

export class GrokAcpDialect implements HarnessDialect {
  private rpcSeq = 100;
  private sessionId: string | null = null;
  private pendingInputs: string[] = [];
  private promptIds = new Set<number>();

  constructor(private readonly cwd: string) {}

  private nextRpcId(): number {
    this.rpcSeq += 1;
    return this.rpcSeq;
  }

  private promptFrame(text: string): JsonObject {
    const rpcId = this.nextRpcId();
    this.promptIds.add(rpcId);
    return {
      jsonrpc: '2.0', id: rpcId, method: 'session/prompt',
      params: { sessionId: this.sessionId, prompt: [{ type: 'text', text }] },
    };
  }

  handshake(): unknown[] {
    return [
      { jsonrpc: '2.0', id: this.nextRpcId(), method: 'initialize',
        params: { protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } } },
      { jsonrpc: '2.0', id: this.nextRpcId(), method: 'session/new',
        params: { cwd: this.cwd, mcpServers: [] } },
    ];
  }

  translateLine(obj: JsonObject): DialectResult {
    const out: HarnessEvent[] = [];
    const outFrames: unknown[] = [];
    const method = obj.method;
    const params = asObject(obj.params);

    if (method == null) {
      // 我们发出的请求的响应
      const result = asObject(obj.result);
      if (result.sessionId && !this.sessionId) {
        this.sessionId = String(result.sessionId);
        for (const queued of this.pendingInputs) {
          outFrames.push(this.promptFrame(queued));
        }
        this.pendingInputs = [];
      }
      const rpcId = typeof obj.id === 'number' ? obj.id : Number.NaN;
      if (this.promptIds.has(rpcId)) {
        this.promptIds.delete(rpcId);
        if (obj.error) {
          out.push({ event: EVENT_RUN_FAILED, error: str(asObject(obj.error).message) || 'error' });
        } else {
          out.push({ event: EVENT_RUN_COMPLETED, output: '', usage: {} });
        }
      } else if (obj.error) {
        out.push({ event: 'harness.stderr',
          text: `rpc error: ${JSON.stringify(obj.error).slice(0, 200)}` });
      }
      return { events: out, outFrames };
    }

    if ('id' in obj) {
      // server→client 请求
      if (method === 'session/request_permission') {
        const toolCall = asObject(params.toolCall);
        out.push({
          event: EVENT_APPROVAL_REQUEST,
          command: str(toolCall.title || toolCall.kind || '工具调用').slice(0, 300),
          description: '',
          choices: ['once', 'always', 'deny'],
          request_id: obj.id,
          raw: { options: asArray(params.options) },
        });
      } else {
        outFrames.push({ jsonrpc: '2.0', id: obj.id,
          error: { code: -32601, message: `unsupported: ${str(method)}` } });
        out.push({ event: 'harness.control_request', raw: { method } });
      }
      return { events: out, outFrames };
    }

    // 通知。x.ai 私有频道(公告/MCP 列表)不进转录。
    if (method !== 'session/update') return { events: out, outFrames };
    const update = asObject(params.update);
    const kind = update.sessionUpdate;
    const content = asObject(update.content);
    const text = typeof content.text === 'string' ? content.text : null;
    if (kind === 'agent_message_chunk' && text) {
      out.push({ event: EVENT_MESSAGE_DELTA, delta: text });
    } else if (kind === 'agent_thought_chunk' && text) {
      out.push({ event: EVENT_REASONING, text });
    } else if (kind === 'tool_call') {
      out.push({ event: EVENT_TOOL_STARTED,
        tool: str(update.kind || 'tool'),
        preview: str(update.title).slice(0, 200),
        tool_use_id: update.toolCallId });
    } else if (kind === 'tool_call_update') {
      const status = update.status;
      if (status === 'completed' || status === 'failed') {
        out.push({ event: EVENT_TOOL_COMPLETED,
          tool: str(update.kind || 'tool'),
          error: status === 'failed',
          tool_use_id: update.toolCallId });
      }
    }
    // user_message_chunk 是自己输入的回显,plan/available_commands 不进转录
    return { events: out, outFrames };
  }

  userMessage(text: string): UserMessageResult {
    if (this.sessionId) return { frames: [this.promptFrame(text)] };
    this.pendingInputs.push(text);
    return { queued: true };
  }

  approvalPayload(pending: JsonObject, choice: string): unknown | null {
    const requestId = pending.request_id;
    if (requestId == null) return null;
    // 选项 id 由 CLI 提供(kind: allow_once/allow_always/reject_once…),
    // 按语义挑;找不到就退回第一个 reject,绝不误放行。
    const options = asArray(asObject(pending.raw).options).map(asObject);
    const allowed = choiceAllowed(choice);
    const wants: Record<string, string> = { once: 'allow_once', always: 'allow_always', deny: 'reject_once' };
    const want = wants[choice] ?? 'reject_once';
    let optionId: unknown = null;
    for (const opt of options) {
      if (opt.kind === want) { optionId = opt.optionId; break; }
    }
    if (optionId == null) {
      for (const opt of options) {
        if (str(opt.kind).startsWith(allowed ? 'allow' : 'reject')) { optionId = opt.optionId; break; }
      }
    }
    if (optionId == null) return null;
    return { jsonrpc: '2.0', id: requestId,
      result: { outcome: { outcome: 'selected', optionId } } };
  }
}

export function createDialect(kind: string, cwd: string): HarnessDialect {
  switch (kind) {
    case 'claude_stream_json': return new ClaudeStreamJsonDialect();
    case 'pi_rpc': return new PiRpcDialect();
    case 'codex_app_server': return new CodexAppServerDialect(cwd);
    case 'grok_acp': return new GrokAcpDialect(cwd);
    default: return new ClaudeStreamJsonDialect();
  }
}
