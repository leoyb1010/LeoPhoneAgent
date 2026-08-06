/**
 * 单消费者 async queue —— 多生产者 push + 单次 end()。
 *
 * 同一个算法在 vendor/codex/sessionWrapper.ts 和 maker-host/agents/async-queue.ts
 * 都用过，搬到 maker-core/agents/shared/ 让 Claude / Codex agent 共用。
 */

export interface AsyncQueue<T> extends AsyncIterable<T> {
  push(item: T): boolean;
  end(): void;
  /** 丢弃尚未被消费者取走的排队项,不结束队列。用于用户主动 Stop 时取消 queued turn。 */
  clear(): void;
  /** 未被消费者取走的排队项数量。0 = 空; >0 = 消费者拿完当前 item 后立即有下一个。 */
  readonly pending: number;
}

export function createAsyncQueue<T>(): AsyncQueue<T> {
  const items: T[] = [];
  const waiters: Array<(done: boolean) => void> = [];
  let ended = false;

  function push(item: T): boolean {
    if (ended) return false;
    if (waiters.length > 0) {
      items.push(item);
      waiters.shift()!(false);
    } else {
      items.push(item);
    }
    return true;
  }

  function end(): void {
    if (ended) return;
    ended = true;
    while (waiters.length > 0) {
      waiters.shift()!(true);
    }
  }

  function clear(): void {
    items.length = 0;
  }

  async function* iterate(): AsyncGenerator<T> {
    while (true) {
      if (items.length > 0) {
        yield items.shift() as T;
      } else if (ended) {
        return;
      } else {
        await new Promise<boolean>((resolve) => {
          waiters.push(resolve);
        });
      }
    }
  }

  return {
    push,
    end,
    clear,
    get pending() {
      return items.length;
    },
    [Symbol.asyncIterator]: () => iterate(),
  };
}
