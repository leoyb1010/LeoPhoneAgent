import { FormStatus } from '../form/FormStatus';
import { TaskLiveView } from '../live/TaskLiveView';

export class TaskStatus {
  cardsEnabled: boolean = true;
  torchOn: boolean = false;
  lastTodo: string = '';
  running: boolean = false;
  pendingWrite: boolean = false;
  private runningOwners: Set<string> = new Set();
  private approvalOwners: Set<string> = new Set();
  private liveIds: Map<string, number> = new Map();
  private nextLiveId: number = 120000;

  setCardsEnabled(on: boolean): void {
    this.cardsEnabled = on;
    this.bump();
  }

  setTorchOn(on: boolean): void {
    this.torchOn = on;
    this.bump();
  }

  setLastTodo(title: string): void {
    this.lastTodo = title;
    this.bump();
  }

  setRunning(on: boolean, owner: string = 'legacy'): void {
    if (on) this.runningOwners.add(owner);
    else this.runningOwners.delete(owner);
    this.running = this.runningOwners.size > 0;
    this.updateLive(owner);
    this.bump();
  }

  setPendingWrite(on: boolean, owner: string = 'legacy'): void {
    if (on) this.approvalOwners.add(owner);
    else this.approvalOwners.delete(owner);
    this.pendingWrite = this.approvalOwners.size > 0;
    this.updateLive(owner);
    this.bump();
  }

  private updateLive(owner: string): void {
    const running = this.runningOwners.has(owner);
    const pending = this.approvalOwners.has(owner);
    let id = this.liveIds.get(owner);
    if (id === undefined) {
      if (!running && !pending) return;
      id = this.nextLiveId++;
      this.liveIds.set(owner, id);
    }
    const finished = !running && !pending;
    const state = pending ? '等待你确认' : (running ? '任务进行中' : '任务已结束');
    TaskLiveView.update(id, state, finished).catch(() => {});
    if (finished) this.liveIds.delete(owner);
  }

  private bump(): void {
    const pending = Array.from<string>(this.approvalOwners);
    const running = Array.from<string>(this.runningOwners);
    const owner = pending[0] ?? running[0] ?? '';
    FormStatus.publish(this.runningOwners.size, this.approvalOwners.size, owner);
    AppStorage.setOrCreate('taskTick', Date.now());
  }
}

export const taskStatus: TaskStatus = new TaskStatus();
