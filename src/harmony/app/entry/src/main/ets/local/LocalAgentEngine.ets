import { common } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { OpenAICompatClient, StreamTurn } from './OpenAICompatClient';
import { FastLocalActions } from './FastLocalActions';
import { LocalTools, ToolResult } from './LocalTools';
import { SensitiveToolGate } from './SensitiveToolGate';
import {
  FailoverSlot,
  LOOP_STOP_AT,
  LOOP_WARN_AT,
  LoopTurn,
  MAX_TOOL_ROUNDS,
  ToolCall,
  ToolLoopGuard,
  loopWarning,
  nextDelta,
  shouldFailover
} from './LocalProtocol';
import { providerStore } from '../store/ProviderStore';
import { usageStore } from '../store/UsageStore';
import { taskStatus } from '../store/TaskStatus';

/**
 * 远程控制端看到的文字:base 是前面几轮已经定下的,text 是到现在为止的全文,sent 是已经发出去的。
 * 换模型重来时 text 退回 base,追上之前不重发;原来会把半截回答和重来的整段都发一遍。
 */
class DeltaDraft {
  base: string = '';
  text: string = '';
  sent: string = '';
}

export class LocalAgentEngine {
  private static gen: Map<string, number> = new Map();
  private static reqs: Map<string, http.HttpRequest> = new Map();
  private static guards: Map<string, ToolLoopGuard> = new Map();
  private static drafts: Map<string, DeltaDraft> = new Map();

  static bump(sessionKey: string): number {
    const next = (LocalAgentEngine.gen.get(sessionKey) ?? 0) + 1;
    LocalAgentEngine.gen.set(sessionKey, next);
    const req = LocalAgentEngine.reqs.get(sessionKey);
    if (req) {
      req.destroy();
      LocalAgentEngine.reqs.delete(sessionKey);
    }
    return next;
  }

  /**
   * 一轮结束后释放这条会话占着的原生 http 句柄。
   * release 是在 streamTurn 的 onDone/onError 回调里调的，也就是还在这个请求自己的
   * 事件帧内，所以 destroy 推到下一个宏任务再做，避免在回调栈里销毁自己。
   */
  private static release(sessionKey: string): void {
    const req = LocalAgentEngine.reqs.get(sessionKey);
    if (!req) {
      return;
    }
    LocalAgentEngine.reqs.delete(sessionKey);
    setTimeout(() => {
      try {
        req.destroy();
      } catch (_err) {
        // 已经被 bump() 销毁过时忽略
      }
    }, 0);
  }

  static current(sessionKey: string): number {
    return LocalAgentEngine.gen.get(sessionKey) ?? 0;
  }

  static alive(sessionKey: string, mine: number): boolean {
    return LocalAgentEngine.current(sessionKey) === mine;
  }

  static stop(sessionKey: string): void {
    LocalAgentEngine.bump(sessionKey);
    taskStatus.setRunning(false);
  }

  /**
   * 会话被淘汰时把这两张按 sessionId 存的 Map 里的死键一起清掉。
   * 它们之前只写不删,会话表加了上限之后如果不清,键还是会跟着 sessionId 无限长。
   */
  static forget(sessionKey: string): void {
    LocalAgentEngine.release(sessionKey);
    LocalAgentEngine.gen.delete(sessionKey);
    LocalAgentEngine.guards.delete(sessionKey);
    LocalAgentEngine.drafts.delete(sessionKey);
  }

  static run(context: common.UIAbilityContext, sessionKey: string, mine: number, text: string,
    thinking: string, onDelta: (delta: string) => void, onDone: (output: string) => void,
    onError: (message: string) => void): http.HttpRequest | null {
    if (!LocalAgentEngine.alive(sessionKey, mine)) {
      return null;
    }
    taskStatus.setRunning(true);
    LocalAgentEngine.guards.set(sessionKey, new ToolLoopGuard());
    LocalAgentEngine.drafts.set(sessionKey, new DeltaDraft());
    FastLocalActions.tryRoute(context, text, 0).then((spoken: string) => {
      if (!LocalAgentEngine.alive(sessionKey, mine)) {
        return;
      }
      if (spoken.length > 0) {
        taskStatus.setRunning(false);
        onDone(spoken);
        return;
      }
      const turns: LoopTurn[] = [];
      const user = new LoopTurn();
      user.role = 'user';
      user.content = text;
      turns.push(user);
      LocalAgentEngine.loop(context, sessionKey, mine, turns, thinking, 0, 0, onDelta, onDone, onError);
    }).catch((err: Error) => {
      taskStatus.setRunning(false);
      onError(err.message);
    });
    return LocalAgentEngine.reqs.get(sessionKey) ?? null;
  }

  private static loop(context: common.UIAbilityContext, sessionKey: string, mine: number,
    turns: LoopTurn[], thinking: string, rounds: number, failIndex: number,
    onDelta: (delta: string) => void, onDone: (output: string) => void,
    onError: (message: string) => void): void {
    LocalAgentEngine.begin(context, sessionKey, mine, turns, thinking, rounds, failIndex,
      onDelta, onDone, onError).catch((err: Error) => {
      taskStatus.setRunning(false);
      onError(err.message);
    });
  }

  private static async begin(context: common.UIAbilityContext, sessionKey: string, mine: number,
    turns: LoopTurn[], thinking: string, rounds: number, failIndex: number,
    onDelta: (delta: string) => void, onDone: (output: string) => void,
    onError: (message: string) => void): Promise<void> {
    if (!LocalAgentEngine.alive(sessionKey, mine)) {
      return;
    }
    await providerStore.ensureLoaded(context);
    await SensitiveToolGate.load(context);
    if (!LocalAgentEngine.alive(sessionKey, mine)) {
      return;
    }
    if (!providerStore.configured()) {
      taskStatus.setRunning(false);
      onError('这台鸿蒙还没配 AI 服务商');
      return;
    }
    if (rounds >= MAX_TOOL_ROUNDS) {
      taskStatus.setRunning(false);
      onError(`一次任务最多 ${MAX_TOOL_ROUNDS} 轮工具,已经停下`);
      return;
    }
    const queue: FailoverSlot[] = providerStore.queue();
    if (failIndex >= queue.length) {
      taskStatus.setRunning(false);
      onError('所有 AI 服务商都试过了,都没成功');
      return;
    }
    const slot = queue[failIndex];
    const key = providerStore.keyFor(slot.instanceId);
    const client = await OpenAICompatClient.open(providerStore.slotRoot(slot.instanceId), key, slot.model,
      providerStore.slotType(slot.instanceId), providerStore.slotCredential(slot.instanceId),
      slot.instanceId);
    if (!LocalAgentEngine.alive(sessionKey, mine)) {
      return;
    }
    const draft = LocalAgentEngine.drafts.get(sessionKey) ?? new DeltaDraft();
    LocalAgentEngine.drafts.set(sessionKey, draft);
    const req = client.streamTurn(turns, LocalTools.systemPrompt(), thinking, (delta: string) => {
      if (!LocalAgentEngine.alive(sessionKey, mine)) {
        return;
      }
      draft.text += delta;
      const fresh = nextDelta(draft.sent, draft.text);
      if (fresh.length > 0) {
        draft.sent = draft.text;
        onDelta(fresh);
      }
    }, (turn: StreamTurn) => {
      // 之前只 delete、不 destroy：http.createHttp() 拿到的原生句柄每轮对话漏一个。
      // 只有 bump() 那条路径会 destroy，正常跑完和报错这两条都不会。
      LocalAgentEngine.release(sessionKey);
      if (!LocalAgentEngine.alive(sessionKey, mine)) {
        return;
      }
      if (turn.calls.length === 0) {
        usageStore.add(context, turn.promptTokens, turn.completionTokens).catch(() => {
          // keep chatting
        });
        taskStatus.setRunning(false);
        onDone(turn.text);
        return;
      }
      // 这一轮说的话定下来了,下一轮接在后面。
      draft.base = draft.text;
      LocalAgentEngine.tools(context, sessionKey, mine, turns, turn.calls, thinking, rounds + 1,
        failIndex, onDelta, onDone, onError);
    }, (message: string) => {
      LocalAgentEngine.release(sessionKey);
      if (!LocalAgentEngine.alive(sessionKey, mine)) {
        return;
      }
      if (shouldFailover(message) && failIndex + 1 < providerStore.queue().length) {
        // 换下一个模型重来这一轮:文字退回这一轮开头。
        draft.text = draft.base;
        LocalAgentEngine.loop(context, sessionKey, mine, turns, thinking, 0, failIndex + 1,
          onDelta, onDone, onError);
        return;
      }
      taskStatus.setRunning(false);
      onError(message);
    });
    LocalAgentEngine.reqs.set(sessionKey, req);
  }

  private static async tools(context: common.UIAbilityContext, sessionKey: string, mine: number,
    turns: LoopTurn[], calls: ToolCall[], thinking: string, rounds: number, failIndex: number,
    onDelta: (delta: string) => void, onDone: (output: string) => void,
    onError: (message: string) => void): Promise<void> {
    if (!LocalAgentEngine.alive(sessionKey, mine)) {
      return;
    }
    const assistant = new LoopTurn();
    assistant.role = 'assistant';
    assistant.calls = calls;
    turns.push(assistant);
    for (let i = 0; i < calls.length; i++) {
      if (!LocalAgentEngine.alive(sessionKey, mine)) {
        return;
      }
      // owner 传 sessionKey：远程/定时这两条链路没有 UI 授权入口，
      // 传了也永远配不上本机聊天页的授权;只有这台鸿蒙开了「全自动」时才能写。
      const result: ToolResult = await LocalTools.run(context, calls[i].name, calls[i].args, sessionKey);
      if (result.needWrite) {
        onError('这台鸿蒙是「逐项确认」,远程和定时任务不能写文件;在鸿蒙上切到「全自动」后可以');
        return;
      }
      const guard = LocalAgentEngine.guards.get(sessionKey) ?? new ToolLoopGuard();
      LocalAgentEngine.guards.set(sessionKey, guard);
      const times = guard.note(calls[i].name, calls[i].args);
      const tool = new LoopTurn();
      tool.role = 'tool';
      tool.toolCallId = calls[i].id.length > 0 ? calls[i].id : `call_${i}`;
      tool.toolName = calls[i].name;
      tool.content = times >= LOOP_WARN_AT ? result.text + loopWarning(calls[i].name, times) : result.text;
      turns.push(tool);
      if (times >= LOOP_STOP_AT) {
        taskStatus.setRunning(false);
        onError(`${calls[i].name} 用同样的参数调用了 ${times} 次,已经停下`);
        return;
      }
    }
    LocalAgentEngine.loop(context, sessionKey, mine, turns, thinking, rounds, failIndex, onDelta, onDone, onError);
  }
}
