import { BackupStore } from '../backup/BackupStore';
import { BackupLease } from '../backup/BackupAccess';
import { AgentExtensionAbility, common, Want } from '@kit.AbilityKit';
import { createA2AServer, RequestContext, Role, Server, TaskState } from '@kit.AgentFrameworkKit';
import { util } from '@kit.ArkTS';
import { LocalAgentEngine } from '../local/LocalAgentEngine';
import { LocalTools } from '../local/LocalTools';
import { providerStore } from '../store/ProviderStore';
import { sessionStore } from '../store/SessionStore';
import { AgentSettings } from './AgentSettings';

class AgentTask {
  key: string = '';
  caller: string = '';
  sessionId: string = '';
  cancelled: boolean = false;
  engineStarted: boolean = false;
  completing: boolean = false;
  lease: BackupLease | null = null;
}

/** API 26 A2A host. All incoming calls use the existing unattended tool policy. */
export default class LeoAgentAbility extends AgentExtensionAbility {
  private server: Server | null = null;
  private tasks: Map<string, AgentTask> = new Map();
  private cancelled: Set<string> = new Set();

  onCreate(want: Want): void {
    this.server = createA2AServer(this.context.agentCard,
      (operation: string, request: RequestContext) => {
        this.dispatch(operation, request).catch(() => {
          const id = request.getTaskId();
          if (id) {
            this.status(id, TaskState.FAILED, '智能体执行失败，请在 LeoBot 检查连接和模型配置。');
          }
        });
      }, want);
  }

  onConnect(_want: Want, _proxy: common.AgentHostProxy): void {
    this.server?.start();
  }

  onAuth(proxy: common.AgentHostProxy, data: string): void {
    const reply = this.server?.onAuth(data);
    if (reply) {
      proxy.sendData(reply);
    }
  }

  onData(proxy: common.AgentHostProxy, data: string): void {
    if (data.length > 128 * 1024) {
      return;
    }
    this.server?.onMessage(data, (reply: string) => { proxy.sendData(reply); });
  }

  onDisconnect(_want: Want, _proxy: common.AgentHostProxy): void {
    // Other connected callers and their tasks remain active.
  }

  onDestroy(): void {
    this.tasks.forEach((task: AgentTask) => {
      task.cancelled = true;
      LocalAgentEngine.stop(task.key);
      if (task.engineStarted && !task.completing) { task.lease?.release(); task.lease = null; }
    });
    this.tasks.clear();
    this.server?.stop();
    this.server = null;
  }

  private async dispatch(operation: string, request: RequestContext): Promise<void> {
    const id = request.getTaskId() ?? '';
    const caller = request.getAgentId() ?? '';
    if (!id || !caller) {
      return;
    }
    const existing = this.tasks.get(id);
    const identity = caller + '\u0000' + id;
    if (operation === 'Cancel') {
      if (existing && existing.caller !== caller) { return; }
      this.cancelled.add(identity);
      if (existing) {
        existing.cancelled = true;
        LocalAgentEngine.stop(existing.key);
        this.tasks.delete(id);
        if (existing.engineStarted && !existing.completing) { existing.lease?.release(); existing.lease = null; }
        this.status(id, TaskState.CANCELED, '任务已停止');
      }
      return;
    }
    if (operation !== 'Execute') {
      this.status(id, TaskState.REJECTED, '该系统操作尚未开放');
      return;
    }
    const prompt = request.getUserInput('\n').trim();
    if (existing || this.cancelled.has(identity)) {
      return;
    }
    if (!prompt || prompt.length > 32768 || this.tasks.size >= 4) {
      this.status(id, TaskState.REJECTED, '请求为空、过长或并发任务已满');
      return;
    }
    const task = new AgentTask();
    task.caller = caller;
    task.key = 'a2a:' + id;
    this.tasks.set(id, task);
    try {
      task.lease = BackupStore.beginExecution(this.context);
      const enabled = await AgentSettings.enabled(this.context);
      if (!this.isCurrent(id, task)) { return; }
      if (!enabled) {
        this.tasks.delete(id);
        this.status(id, TaskState.AUTH_REQUIRED, '请先在 LeoBot 的系统集成页允许系统智能体调用');
        return;
      }
      await Promise.all([providerStore.ensureLoaded(this.context), LocalTools.hydrate(this.context)]);
      if (!this.isCurrent(id, task)) { return; }
      const stillEnabled = await AgentSettings.enabled(this.context);
      if (!this.isCurrent(id, task)) { return; }
      if (!stillEnabled) { this.tasks.delete(id); return; }
      const session = await sessionStore.create(this.context, '系统智能体');
      if (!this.isCurrent(id, task)) { return; }
      task.sessionId = session.id;
      await sessionStore.append(this.context, session.id, 'user', prompt);
      if (!this.isCurrent(id, task)) { return; }
      this.status(id, TaskState.WORKING, '正在处理');
      const generation = LocalAgentEngine.bump(task.key);
      task.engineStarted = true;
      LocalAgentEngine.run(this.context, task.key, generation, prompt, '', () => {},
        (output: string) => {
          this.complete(id, task, output).catch(() => {
            this.status(id, TaskState.FAILED, '结果已生成，但保存失败，请在 LeoBot 检查');
          });
        }, (message: string) => {
          if (this.isCurrent(id, task)) {
            this.tasks.delete(id);
            this.status(id, TaskState.FAILED, message);
            LocalAgentEngine.forget(task.key);
            task.lease?.release(); task.lease = null;
          }
        });
    } catch (_err) {
      if (!this.isCurrent(id, task)) { return; }
      this.tasks.delete(id);
      LocalAgentEngine.forget(task.key);
      this.status(id, TaskState.FAILED, '无法执行任务，请先完成备份恢复并检查本机模型配置');
    } finally {
      if (!task.engineStarted || (!this.isCurrent(id, task) && !task.completing)) { task.lease?.release(); task.lease = null; }
    }
  }

  private async complete(id: string, task: AgentTask, output: string): Promise<void> {
    if (!this.isCurrent(id, task)) { return; }
    task.completing = true;
    try {
      await sessionStore.append(this.context, task.sessionId, 'assistant', output);
      if (!this.isCurrent(id, task)) { return; }
      this.server?.addArtifact(id, {
        name: 'LeoBot 回答', parts: [{ text: output, mediaType: 'text/plain' }], lastChunk: true
      });
      this.status(id, TaskState.COMPLETED, output);
    } finally {
      if (this.tasks.get(id) === task) { this.tasks.delete(id); LocalAgentEngine.forget(task.key); }
      task.lease?.release(); task.lease = null;
    }
  }

  private isCurrent(id: string, task: AgentTask): boolean {
    return !task.cancelled && this.tasks.get(id) === task;
  }

  private status(id: string, state: TaskState, text: string): void {
    this.server?.updateStatus(id, {
      state: state, timestamp: new Date().toISOString(),
      message: { messageId: util.generateRandomUUID(true), role: Role.AGENT,
        parts: [{ text: text, mediaType: 'text/plain' }] }
    });
  }
}
