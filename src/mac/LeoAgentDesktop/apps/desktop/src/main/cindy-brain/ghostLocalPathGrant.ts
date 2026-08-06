/**
 * ghostLocalPathGrant.ts — ghost attachments 过户的「任意本地路径」分类器。
 *
 * 附件过户原有三层解析(会话图缓存 / 媒体总仓 blob / 缩图缓存)都不命中、
 * 且输入是一个真实存在的本地文件绝对路径时,走两层策略(2026-07-14 定案):
 *   - 位于会话 workdir 内 → 自动放行(与 dir 目录过户同一信任等级:workdir
 *     内容本就是主 agent 可读可发网的范围);
 *   - 位于 workdir 外(或当前会话没有 workdir)→ 需要用户在确认卡上点允许
 *     (GhostGrantConfirmBridge),把「拖图进聊天」的授权动作换成一次点击。
 *
 * 本模块只做**纯分类**(路径合法性 / realpath 钳制 / mime 判定),不弹窗、
 * 不读文件内容、不落库——那些在 ghost.ts 接线层。mime 判定经 deps 注入
 * (真身 blobStore.mimeForExt,它依赖 electron app,注入后本模块可纯 Node
 * 单测,规则 14)。
 *
 * 钳制口径与 dirDeposit 完全一致:realpath 归一化后再比(词法比较防不了
 * symlink / junction),解不开真身一律按不存在处理。
 */

import fs from 'node:fs';
import path from 'node:path';

import { isPathInsideDir } from './dirDeposit.js';

export type LocalPathClassification =
  /** 不是本分支管的输入(非绝对路径 / 不存在 / 不是普通文件)——交回原有教学错误。 */
  | { kind: 'not-local' }
  /** 是真实文件但扩展名不在媒体总仓白名单(txt/zip 等)——引导改走 dir 通道。 */
  | { kind: 'unsupported-type'; ext: string; name: string }
  | { kind: 'inside-workdir'; absPath: string; mimeType: string; size: number; name: string }
  | { kind: 'outside-workdir'; absPath: string; mimeType: string; size: number; name: string };

export interface LocalPathGrantDeps {
  /** 扩展名(含点,小写)→ mime;白名单外 null(真身 blobStore.mimeForExt)。 */
  mimeForExt(ext: string): string | null;
}

/**
 * 分类一个候选附件地址。workdirAbs 为 null 表示当前会话没有工作目录
 * (对话型会话)——此时任何本地路径都归 outside-workdir(必须确认)。
 */
export function classifyLocalAttachmentPath(
  input: string,
  workdirAbs: string | null,
  deps: LocalPathGrantDeps,
): LocalPathClassification {
  if (typeof input !== 'string' || input.includes('\0') || !path.isAbsolute(input)) {
    return { kind: 'not-local' };
  }
  let realFile: string;
  try {
    realFile = fs.realpathSync.native(input);
  } catch {
    return { kind: 'not-local' };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(realFile);
  } catch {
    return { kind: 'not-local' };
  }
  if (!stat.isFile()) return { kind: 'not-local' };

  const name = path.basename(realFile);
  const ext = path.extname(realFile).toLowerCase();
  const mimeType = deps.mimeForExt(ext);
  if (!mimeType) return { kind: 'unsupported-type', ext, name };

  let inside = false;
  if (workdirAbs) {
    try {
      const realWorkdir = fs.realpathSync.native(workdirAbs);
      inside = isPathInsideDir(realWorkdir, realFile);
    } catch {
      inside = false; // workdir 本身解析不了(远程/已删)→ 按外部处理,走确认
    }
  }
  const base = { absPath: realFile, mimeType, size: stat.size, name };
  return inside ? { kind: 'inside-workdir', ...base } : { kind: 'outside-workdir', ...base };
}
