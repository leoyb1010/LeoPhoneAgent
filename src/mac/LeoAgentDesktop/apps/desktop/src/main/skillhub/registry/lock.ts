/**
 * lock.ts — per-skillName 串行队列。
 *
 * 不同 skillName 互不阻塞；同 skillName 写操作严格串行。
 * 读操作不入队（最坏读到上一次提交的状态）。
 */

const queues = new Map<string, Promise<unknown>>();

export async function withLock<T>(skillName: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(skillName) ?? Promise.resolve();
  const next = prev.then(() => fn(), () => fn()); // prev 失败也执行 next
  queues.set(skillName, next);
  try {
    return await next;
  } finally {
    // 队列清理:如果当前 promise 仍是队尾,移除以释放内存
    if (queues.get(skillName) === next) queues.delete(skillName);
  }
}
