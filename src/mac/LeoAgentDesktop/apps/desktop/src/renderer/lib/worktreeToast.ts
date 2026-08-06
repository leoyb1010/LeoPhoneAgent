/**
 * worktreeToast — 把 main 侧返回的 WorktreeError 翻成 toast。
 *
 * worktree-parallel-sessions 前端方案 M8：
 *   - 6 类已知错误均带 hint，直接复用 main 的 message + hint 作为最终展示
 *   - unknown 类型回显 rawStderr（用户可截图反馈）
 *   - dubious-ownership：到这里说明 main 已自动重试仍失败，hint 提示
 *     用户检查 git config 的 safe.directory
 *
 * Toast 视觉规格沿用项目内通用 toast（lib/toast.ts），不为 worktree
 * 单独定制样式，只补文案。
 */

import { toast } from './toast';
import type { WorktreeError } from './worktree.types';
import { i18n } from '@/i18n';

/** 把 WorktreeError 的 kebab-case kind 映射到 locale JSON 里的 camelCase key。 */
const KIND_TO_KEY: Record<WorktreeError['kind'], string> = {
  'permission-denied': 'permissionDenied',
  'git-crypt-locked': 'gitCryptLocked',
  'dubious-ownership': 'dubiousOwnership',
  'lfs-error': 'lfsError',
  'not-a-git-repo': 'notAGitRepo',
  'git-not-installed': 'gitNotInstalled',
  unknown: 'unknown',
};

/**
 * 把 WorktreeError 渲染为一条 toast。
 *
 * - 标题优先用 main 给的 message；缺失才走 i18n fallback
 * - 描述优先用 main 给的 hint；unknown 类型若 hint 也缺失，回退到 rawStderr
 * - duration 走 error 默认时长（lib/toast.ts），不再单独指定
 */
export function showWorktreeError(err: WorktreeError): void {
  const key = KIND_TO_KEY[err.kind];
  const title = err.message?.trim() || i18n.t(`logic.worktree.title.${key}`);
  const hint =
    err.hint?.trim() ||
    (err.kind === 'unknown' && err.rawStderr?.trim()) ||
    i18n.t(`logic.worktree.hint.${key}`);
  const message = hint ? `${title} — ${hint}` : title;
  toast.error(message);
}
