export class TaskStatus {
  cardsEnabled: boolean = true;
  torchOn: boolean = false;
  lastTodo: string = '';
  running: boolean = false;
  pendingWrite: boolean = false;

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

  setRunning(on: boolean): void {
    this.running = on;
    this.bump();
  }

  setPendingWrite(on: boolean): void {
    this.pendingWrite = on;
    this.bump();
  }

  private bump(): void {
    AppStorage.setOrCreate('taskTick', Date.now());
  }
}

export const taskStatus: TaskStatus = new TaskStatus();
