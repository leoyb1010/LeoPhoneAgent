/**
 * reviewMarkdownExts — 审查面板富文本预览支持的 Markdown 扩展名清单。
 *
 * 抽到 shared 是因为 main 和 renderer 都要用同一套判定:
 *  - main/git-review/markdownReader.ts: 决定是否读取变更后的 Markdown 内容
 *  - renderer review panel: 决定是否把 diff 主体替换成富文本预览
 */
export const REVIEW_MARKDOWN_EXTS: ReadonlySet<string> = new Set([
  '.md',
  '.mdx',
  '.markdown',
  '.mkd',
  '.mdown',
]);

export function reviewMarkdownExtensionOf(gitPath: string | null | undefined): string {
  const name = gitPath?.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

export function isReviewMarkdownPath(gitPath: string | null | undefined): boolean {
  return REVIEW_MARKDOWN_EXTS.has(reviewMarkdownExtensionOf(gitPath));
}
