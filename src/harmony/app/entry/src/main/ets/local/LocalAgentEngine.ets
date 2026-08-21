import { common } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { OpenAICompatClient, StreamTurn } from './OpenAICompatClient';
import { LocalTools, ToolResult } from './LocalTools';
import { FailoverSlot, LoopTurn, ToolCall, shouldFailover } from './LocalProtocol';
import { providerStore } from '../store/ProviderStore';
import { usageStore } from '../store/UsageStore';

export class LocalAgentEngine {
  private static gen: Map<string, number> = new Map();
  private static reqs: Map<string, http.HttpRequest> = new Map();

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
  }

  /**
   * 会话被淘汰时把这两张按 sessionId 存的 Map 里的死键一起清掉。
   * 它们之前只写不删,会话表加了上限之后如果不清,键还是会跟着 sessionId 无限长。
   */
  static forget(sessionKey: string): void {
    LocalAgentEngine.release(sessionKey);
    LocalAgentEngine.gen.delete(sessionKey);
  }

  static run(context: common.UIAbilityContext, sessionKey: string, mine: number, text: string,
    thinking: string, onDelta: (delta: string) => void, onDone: (output: string) => void,
    onError: (message: string) => void): http.HttpRequest | null {
    if (!LocalAgentEngine.alive(sessionKey, mine)) {
      return null;
    }
    const turns: LoopTurn[] = [];
    const user = new LoopTurn();
    user.role = 'user';
    user.content = text;
    turns.push(user);
    LocalAgentEngine.loop(context, sessionKey, mine, turns, thinking, 0, 0, onDelta, onDone, onError);
    return LocalAgentEngine.reqs.get(sessionKey) ?? null;
  }

  private static loop(context: common.UIAbilityContext, sessionKey: string, mine: number,
    turns: LoopTurn[], thinking: string, rounds: number, failIndex: number,
    onDelta: (delta: string) => void, onDone: (output: string) => void,
    onError: (message: string) => void): void {
    LocalAgentEngine.begin(context, sessionKey, mine, turns, thinking, rounds, failIndex,
      onDelta, onDone, onError).catch((err: Error) => {
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
    if (!LocalAgentEngine.alive(sessionKey, mine)) {
      return;
    }
    if (!providerStore.configured()) {
      onError('这台鸿蒙还没配供应商');
      return;
    }
    if (rounds >= 8) {
      onError('工具轮次用完了');
      return;
    }
    const queue: FailoverSlot[] = providerStore.queue();
    if (failIndex >= queue.length) {
      onError('供应商都试过了');
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
    const req = client.streamTurn(turns, LocalTools.systemPrompt(), thinking, (delta: string) => {
      if (LocalAgentEngine.alive(sessionKey, mine)) {
        onDelta(delta);
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
        onDone(turn.text);
        return;
      }
      LocalAgentEngine.tools(context, sessionKey, mine, turns, turn.calls, thinking, rounds + 1,
        failIndex, onDelta, onDone, onError);
    }, (message: string) => {
      LocalAgentEngine.release(sessionKey);
      if (!LocalAgentEngine.alive(sessionKey, mine)) {
        return;
      }
      if (shouldFailover(message) && failIndex + 1 < providerStore.queue().length) {
        LocalAgentEngine.loop(context, sessionKey, mine, turns, thinking, 0, failIndex + 1,
          onDelta, onDone, onError);
        return;
      }
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
      // 传了也永远配不上本机聊天页的授权，file_write 会照常落到 needWrite 分支被拒。
      const result: ToolResult = await LocalTools.run(context, calls[i].name, calls[i].args, sessionKey);
      if (result.needWrite) {
        onError('远程指挥写文件需要本机先点允许');
        return;
      }
      const tool = new LoopTurn();
      tool.role = 'tool';
      tool.toolCallId = calls[i].id.length > 0 ? calls[i].id : `call_${i}`;
      tool.toolName = calls[i].name;
      tool.content = result.text;
      turns.push(tool);
    }
    LocalAgentEngine.loop(context, sessionKey, mine, turns, thinking, rounds, failIndex, onDelta, onDone, onError);
  }
}
