/** 单一 origin 的 IO 生命周期；退出等待所有旧响应结束，再清理 Cookie。 */
export class PaperclipSessionScope {
  generation = 0;
  signingOut = false;
  private readonly active = new Set<{ controller: AbortController; done: Promise<void> }>();

  async run<T>(work: (signal: AbortSignal) => Promise<T>, allowSignOut = false): Promise<T> {
    if (this.signingOut && !allowSignOut) throw new Error("正在退出服务器，请稍候");
    const epoch = this.generation;
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const record = { controller, done };
    this.active.add(record);
    try {
      const result = await work(AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]));
      if (epoch !== this.generation) throw new Error("服务器会话已更改，请重新连接");
      return result;
    } finally {
      this.active.delete(record);
      finish();
    }
  }

  async beginSignOut(): Promise<void> {
    if (this.signingOut) throw new Error("正在退出服务器，请稍候");
    this.signingOut = true;
    this.generation += 1;
    const pending = [...this.active];
    for (const item of pending) item.controller.abort();
    await Promise.all(pending.map((item) => item.done));
  }

  finishSignOut(): void {
    this.signingOut = false;
  }
}
