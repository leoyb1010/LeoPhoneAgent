// ============================================================
// [leo] 按文件串行化写操作
// ============================================================
// 同一进程里的多个会话 / 子代理可能同时 Edit/Write 同一个文件：读 → 匹配 → 写之间被另一方插入，
// 后写的一方要么撞 expectedRevision 冲突，要么覆盖对方。这里按规范化路径排队：同一文件的
// 变更依次执行，不同文件照常并行。排到之后 handler 自己重新读文件、做 read-before-edit 校验。
// 参考 pi coding agent 的 withFileMutationQueue（MIT, Copyright (c) 2025 Mario Zechner），
// 这里不做 realpath（core 不直接碰文件系统），按 normalizeToolPathForComparison 的结果作键。

import { resolve } from "node:path";
import { normalizeToolPathForComparison } from "../path-normalization.js";

const queues = new Map<string, Promise<void>>();

export async function withLeoFileMutationQueue<T>(
  filePath: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = normalizeToolPathForComparison(filePath);
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  queues.set(key, chained);

  await previous;
  try {
    return await run();
  } finally {
    release();
    if (queues.get(key) === chained) queues.delete(key);
  }
}

/**
 * 从 Edit/Write 入参里取出目标文件作队列键：相对路径按工作目录解析；取不到时退回空键
 * （这类调用会在 handler 里以参数错误快速失败，一起排队也无妨）。
 */
export function leoMutationKey(input: unknown, workingDirectory: string): string {
  const record = typeof input === "string" ? safeParseJson(input) : input;
  if (typeof record !== "object" || record === null) return "";
  const candidate = ["file_path", "path", "filePath"]
    .map((key) => (record as Record<string, unknown>)[key])
    .find((value): value is string => typeof value === "string" && value.trim() !== "");
  return candidate === undefined ? "" : resolve(workingDirectory, candidate);
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
