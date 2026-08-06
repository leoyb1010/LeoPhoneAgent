/**
 * draftUrlRegistry.ts — 全窗口草稿附件 URL 登记表(第 5 步 review P1 修复)。
 * ---------------------------------------------------------------------------
 * "零引用 ≠ 无主"暂存区 (1) 的完整取证:composerDraftStore 是 renderer 进程内
 * 存,而本产品支持多窗口(secondary-windows 的完整 MainLayout 副窗),每个窗口
 * 是独立 renderer 进程、各有一份草稿托盘——清理发起窗口只能带上自己那份。
 *
 * 对策:每个窗口的草稿附件集合变化时(composerDraftStore 各 mutator 尾部)把
 * 全量 URL 清单推给 main,这里按 webContentsId 登记;回收器取证 = 全窗口并集。
 * 窗口销毁即清行(草稿本就是内存态,窗口没了草稿也没了)。上报是尽力而为的
 * 防误删信号:宁可多保护(登记表滞后于删除只会多留几个文件),不可漏保护。
 */

import type { WebContents } from 'electron';

const registry = new Map<number, string[]>();
/** 已挂 destroyed 清理钩子的 webContents(防重复挂监听)。 */
const hooked = new Set<number>();

/** 登记某窗口的当前草稿附件 URL 全量清单(覆盖写)。 */
export function reportDraftUrls(sender: WebContents, urls: string[]): void {
  if (!Array.isArray(urls)) return;
  const id = sender.id;
  registry.set(
    id,
    urls.filter((u): u is string => typeof u === 'string').slice(0, 1000),
  );
  if (!hooked.has(id)) {
    hooked.add(id);
    sender.once('destroyed', () => {
      registry.delete(id);
      hooked.delete(id);
    });
  }
}

/** 全窗口草稿附件 URL 并集(回收器活引用取证用)。 */
export function getAllRegisteredDraftUrls(): string[] {
  const urls: string[] = [];
  for (const list of registry.values()) urls.push(...list);
  return urls;
}

/** 测试辅助:清空登记表。 */
export function resetDraftUrlRegistry(): void {
  registry.clear();
  hooked.clear();
}
