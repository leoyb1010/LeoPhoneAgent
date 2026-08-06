/**
 * lastViewStore — 持久化用户上一次在 cc-agent 区的视图位置。
 *
 * 目的：App 重启 / 切 tab 回到 /cc-agent 时,把用户带回上一次的位置,而不是
 * 每次都跳到「最近一条 session」。
 *
 * 设计要点：
 *   - 拆成两个互不影响的 slot:
 *       · chat slot —— /cc-agent/new 或 /cc-agent/:sessionId 这类聊天视图
 *       · doc  slot —— /cc-agent/files/:sessionId 这类 workdir 文件浏览视图
 *     之所以拆开:用户在 doc 里换 session 不应该覆盖掉聊天选中的 session,
 *     反之亦然。原先两边混存一个全局 slot 导致互相覆盖。
 *   - sessionId 的存在性校验由调用方完成(session 可能已被删除/归档)。
 *   - 写入容错：localStorage 满 / 禁用时静默降级,不影响主流程。
 *
 * 旧版 v1 单 slot key (`cc-agent.lastView.v1`) 不做迁移,直接弃用 ——
 * 这是 UX 记忆,丢一次无影响。
 */

const CHAT_KEY = 'cc-agent.lastChatView.v1';
const DOC_KEY = 'cc-agent.lastDocView.v1';

/** 聊天视图的最近位置:草稿 (`new`) 或某个具体 session。 */
export type LastChatView =
  | { kind: 'session'; sessionId: string }
  | { kind: 'new' };

/** Doc(文件浏览)视图的最近位置:具体 session。 */
export interface LastDocView {
  sessionId: string;
}

function isValidChat(v: unknown): v is LastChatView {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (obj.kind === 'new') return true;
  if (obj.kind === 'session') {
    return typeof obj.sessionId === 'string' && obj.sessionId.length > 0;
  }
  return false;
}

function isValidDoc(v: unknown): v is LastDocView {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.sessionId === 'string' && obj.sessionId.length > 0;
}

function readJSON(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage 满 / 禁用 — 静默降级。
  }
}

export function loadLastChatView(): LastChatView | null {
  const parsed = readJSON(CHAT_KEY);
  return isValidChat(parsed) ? parsed : null;
}

export function saveLastChatView(view: LastChatView): void {
  writeJSON(CHAT_KEY, view);
}

export function loadLastDocView(): LastDocView | null {
  const parsed = readJSON(DOC_KEY);
  return isValidDoc(parsed) ? parsed : null;
}

export function saveLastDocView(view: LastDocView): void {
  writeJSON(DOC_KEY, view);
}

export function clearLastView(): void {
  try {
    localStorage.removeItem(CHAT_KEY);
    localStorage.removeItem(DOC_KEY);
  } catch {
    // ignore
  }
}
