import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { LocalAgentEngine } from './LocalAgentEngine';

class ChildTask {
  id: string = '';
  owner: string = '';
  cancel: () => void = () => {};
}

/** 子任务只接收显式任务说明，沿用无人值守权限；结果交回父任务。 */
export class SubAgentTasks {
  private static tasks: Map<string, ChildTask> = new Map();

  static run(context: common.Context, owner: string, prompt: string, isCurrent: () => boolean = () => true, memoryAllowed: () => boolean = () => true): Promise<string> {
    if (!isCurrent()) return Promise.reject(new Error('父任务已停止'));
    if (!owner || owner.startsWith('subagent:')) return Promise.reject(new Error('子代理不能继续创建子代理'));
    if (!prompt.trim() || prompt.length > 16000) return Promise.reject(new Error('子任务说明需要在 1 到 16000 字符以内'));
    const owned = Array.from(SubAgentTasks.tasks.values()).filter((task: ChildTask) => task.owner === owner);
    if (owned.length >= 3 || SubAgentTasks.tasks.size >= 12) return Promise.reject(new Error('子代理运行数量已达上限'));
    return new Promise<string>((resolve: (value: string) => void, reject: (error: Error) => void) => {
      const task = new ChildTask();
      task.id = `subagent:${util.generateRandomUUID()}`;
      task.owner = owner;
      let settled = false;
      let timer: number = -1;
      const finish = (text: string, failed: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer >= 0) clearTimeout(timer);
        SubAgentTasks.tasks.delete(task.id);
        LocalAgentEngine.stop(task.id);
        LocalAgentEngine.forget(task.id);
        if (!isCurrent()) reject(new Error('父任务已停止'));
        else if (failed) reject(new Error(text)); else resolve(text);
      };
      task.cancel = () => finish('子代理已取消', true);
      SubAgentTasks.tasks.set(task.id, task);
      timer = setTimeout(() => finish('子代理超过 3 分钟，已停止', true), 180000);
      const generation = LocalAgentEngine.bump(task.id);
      LocalAgentEngine.run(context, task.id, generation, prompt, '', () => {},
        (output: string) => finish(output, false), (message: string) => finish(message, true), [], memoryAllowed);
    });
  }

  static cancelOwner(owner: string): void {
    const tasks = Array.from(SubAgentTasks.tasks.values());
    for (let i = 0; i < tasks.length; i++) {
      if (tasks[i].owner === owner) tasks[i].cancel();
    }
  }
}
