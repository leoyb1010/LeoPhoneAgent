/**
 * mentionRefFormat.ts
 * ---------------------------------------------------------------------------
 * Inline `@mention` 文本序列化 / 解析的单一真源。
 *
 * 背景：composer 里的 mention chip 在发送时被序列化成纯文本 `@<path>`（见
 * ChatInput.serializeEditorContent），这段文本既持久化用于消息气泡回显，也作为
 * text block 发给 agent。旧实现直接拼 `@${path}`，当 path 含空格时（如
 * `参考-Smack Studio 角色编辑器.md`）下游用 `@\S+` 切词只能吃到第一个空格前的部分，
 * chip 被从空格处截断。
 *
 * 解决办法沿用 maker-core 已有的 `@"..."` 引号约定（见 claude-code/index.ts 的
 * quotedMentionText / hasMentionText）：path 含空格 / 引号时用双引号包裹并转义内部
 * 引号。这样 agent 与气泡渲染都能把整条 path 当成一个 token。
 */

/** path 是否需要加引号才能在 `@\S+` 切词里存活（含空白或引号即需要）。 */
export function mentionRefNeedsQuoting(path: string): boolean {
  return /\s/.test(path) || path.includes('"');
}

/**
 * 把 mention path 格式化成跟在 `@` 后面的文本：需要时用双引号包裹并把内部 `"`
 * 转义成 `\"`。与 maker-core 的 quotedMentionText 保持一致，确保 agent 不会因
 * 格式不符而重复注入引用。
 */
export function formatMentionRef(path: string): string {
  return mentionRefNeedsQuoting(path) ? `"${path.replace(/"/g, '\\"')}"` : path;
}

/**
 * 切词正则：同时识别引号形式 `@"a b.md"` 与裸形式 `@a.md`，配合 String.split
 * 使用（带捕获组以保留分隔片段）。引号分支优先，保证含空格的引用整体命中。
 * 不带 `g` 标志：String.split 本身就是全局拆分，且模块级共享的 `g` 正则带
 * 有状态 lastIndex，将来若有人误用 test()/exec() 会踩坑。
 */
export const MENTION_TOKEN_SPLIT = /(@"(?:\\.|[^"\\])*"|@\S+)/;

/**
 * 解析一个以 `@` 开头的 mention token，取出干净的 path 引用（去引号、反转义）。
 * @returns ref 为不含 `@` 与外层引号的原始 path；quoted 标识是否来自引号形式。
 *
 * 反转义必须与 formatMentionRef 严格对称：序列化只把 `"` 转义成 `\"`，所以这里
 * 只能把 `\"` 还原成 `"`，**不能**把 `\` 当通用转义前缀。否则 Windows 含空格路径
 * （如 `C:\Users\My Documents\file.md`，会被加引号）里的反斜杠会被吞掉，得到
 * `C:UsersMy Documentsfile.md` 这种静默损坏的路径。
 */
export function parseMentionToken(token: string): { ref: string; quoted: boolean } {
  if (token.startsWith('@"') && token.endsWith('"') && token.length >= 3) {
    return { ref: token.slice(2, -1).replace(/\\"/g, '"'), quoted: true };
  }
  return { ref: token.slice(1), quoted: false };
}
