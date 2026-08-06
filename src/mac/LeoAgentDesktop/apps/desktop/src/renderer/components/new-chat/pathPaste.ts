/**
 * pathPaste — 粘贴文本里绝对路径的「stat 确认后升级为 @chip」逻辑。
 *
 * 时序设计(与 session 标题补齐同一套「先落内容、异步原地精化」口径,规则 7):
 *   1. handlePaste 同步插入:path 段先以**纯文本**落进编辑器(不做乐观 chip,
 *      避免 stat 失败再回退产生跳变),并记录每段在插入后文档中的 [from,to);
 *   2. 异步 stat(本地 IPC / SSH / device-link 隧道,按会话来源路由);
 *   3. 确认存在 → 把记录的 range 经「粘贴之后所有事务的累计 mapping」映射到
 *      当前文档,校验该区间文本仍逐字等于原路径后原地替换为 @file / @dir chip
 *      (kind 按 stat 结果)。只动本次粘贴插入的那一段——用户在 stat 窗口期
 *      在别处手敲的相同路径、以及互为前缀的兄弟路径(`a.ts` / `a.ts.bak`)
 *      都不受影响(review P1 ×2:全文档 indexOf 扫描的越界替换与前缀破坏);
 *   4. missing / stat 失败 / 区间被用户编辑过 → 无动作,文本保持原样。
 *
 * 替换事务标 addToHistory:false——撤销粘贴应一步回到粘贴前,不该先退回
 * 「纯文本路径」中间态(与 session 标题补齐同理)。
 *
 * mapping 通过 Tiptap 'transaction' 事件累计(含本模块自己的替换事务——
 * 先落定的替换会移动后续 range,同样要映射),全部 stat 落定后卸载监听。
 *
 * stat 路由与 remoteBrowseAdapters 复用同一批底层通道:
 *   - 本地会话:`fs:stat-path` IPC;
 *   - SSH 远程(remoteHostId):`remoteSsh.statRemotePath`;
 *   - device-link 被控端(deviceLinkDeviceId):经隧道在被控端 stat。
 */
import type { Editor } from '@tiptap/core';
import { Mapping } from '@tiptap/pm/transform';
import type { Transaction } from '@tiptap/pm/state';

import { toWorkdirRelativePath } from './pastePipeline';
import type { MentionChipAttrs } from './MentionChipNode';

export type PathStatKind = 'dir' | 'file' | 'missing';

export interface PathStatContext {
  /** SSH 远程主机 id(与 deviceLinkDeviceId 互斥;都空 = 本地会话)。 */
  remoteHostId?: string | null;
  /** device-link 被控端 id。 */
  deviceLinkDeviceId?: string | null;
}

/** 一段粘贴落地的路径文本:绝对路径 + 插入后文档中的区间(from 含、to 不含)。 */
export interface PendingPathRange {
  absPath: string;
  from: number;
  to: number;
}

/** 按会话来源 stat 一条绝对路径;任何异常按 missing 处理(方向安全)。 */
export async function statPastedPath(
  absPath: string,
  ctx: PathStatContext,
): Promise<PathStatKind> {
  try {
    if (ctx.remoteHostId) {
      const res = await window.electronAPI.remoteSsh.statRemotePath(ctx.remoteHostId, absPath);
      return res.kind;
    }
    if (ctx.deviceLinkDeviceId) {
      const { deviceLinkBrowseAdapter } = await import('./remoteBrowseAdapters');
      const res = await deviceLinkBrowseAdapter(ctx.deviceLinkDeviceId).statPath(absPath);
      return res.kind;
    }
    const res = await window.electronAPI.fsBrowse.statPath(absPath);
    return res.kind;
  } catch {
    return 'missing';
  }
}

function chipAttrsForPath(
  absPath: string,
  workingDir: string,
  kind: 'dir' | 'file',
): MentionChipAttrs {
  const relPath = toWorkdirRelativePath(absPath, workingDir);
  const segs = relPath.split('/');
  const basename = segs[segs.length - 1] || relPath;
  return { kind, label: basename, path: relPath, titled: false };
}

/**
 * 对一批粘贴落地的路径 range 做 stat,确认存在的原地升级为 chip。
 * `statPath` 可注入(单测)。每条 range 独立落定,互不阻塞;区间经累计
 * mapping 跟踪,用户编辑导致区间文本不再等于原路径时放弃升级(诚实降级)。
 */
export function upgradePastedPathsToChips(
  editor: Editor,
  ranges: PendingPathRange[],
  workingDir: string,
  ctx: PathStatContext,
  statPath: (absPath: string, ctx: PathStatContext) => Promise<PathStatKind> = statPastedPath,
): void {
  if (ranges.length === 0) return;
  const mapping = new Mapping();
  const onTransaction = ({ transaction }: { transaction: Transaction }) => {
    mapping.appendMapping(transaction.mapping);
  };
  editor.on('transaction', onTransaction);
  let pending = ranges.length;
  const settle = () => {
    pending -= 1;
    if (pending === 0) editor.off('transaction', onTransaction);
  };
  // 同一路径多次出现时只 stat 一次,结果分发给各 range。
  const statOnce = new Map<string, Promise<PathStatKind>>();
  for (const range of ranges) {
    let promise = statOnce.get(range.absPath);
    if (!promise) {
      promise = statPath(range.absPath, ctx);
      statOnce.set(range.absPath, promise);
    }
    void promise
      .then((kind) => {
        if (kind === 'missing' || editor.isDestroyed) return;
        // assoc:from 取右附着、to 取左附着——区间边缘的插入不并入区间。
        const from = mapping.map(range.from, 1);
        const to = mapping.map(range.to, -1);
        if (to <= from) return;
        const { state } = editor;
        if (to > state.doc.content.size) return;
        // 区间文本必须仍逐字等于原路径(块分隔 / 非文本叶节点占位符用 \u0000,
        // 任何 chip / hardBreak / 换段混入都会导致不等)→ 用户编辑过就放弃升级。
        const current = state.doc.textBetween(from, to, '\u0000', '\u0000');
        if (current !== range.absPath) return;
        const attrs = chipAttrsForPath(range.absPath, workingDir, kind);
        // 空相对路径 = workdir 本体(入口守卫已挡,防御性兜底):宁可保持
        // 原文,也不产出 label / path 全空的降级 chip(review P2)。
        if (!attrs.path) return;
        const tr = state.tr.replaceWith(
          from,
          to,
          state.schema.nodes.mentionChip.create(attrs),
        );
        tr.setMeta('addToHistory', false);
        editor.view.dispatch(tr);
      })
      .catch(() => {
        // stat 失败 → 保持纯文本,不打扰用户
      })
      .finally(settle);
  }
}
