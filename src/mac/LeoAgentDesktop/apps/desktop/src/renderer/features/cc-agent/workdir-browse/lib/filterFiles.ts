/**
 * filterFiles —— 文件名子串筛选(Codex / VSCode Cmd+P 风格)。
 *
 * 输入 query → 在扁平文件名列表中找匹配。返回截前 `limit` 条。
 *
 * 排序策略(用户最常的检索意图优先):
 *  1. basename 命中(关键词出现在文件名最后一段) — 用户多半要找的就是这个;
 *  2. path 中段命中(关键词出现在目录路径里) — 二级匹配。
 *
 * case-insensitive。性能:5w 文件 substring 遍历 ~5-10ms,够实时 onChange。
 *
 * 抽到 workdir-browse/lib 下,RSB plugin 和 doc 模式 sidebar 都从这里 import,
 * 同一份算法两边一致。
 */

/** 文件名筛选结果展示上限。匹配再多也只渲染前 N 条,避免列表爆 + 用户分不清重点。 */
export const FILTER_RESULT_LIMIT = 200;

export function filterFiles(
  query: string,
  files: readonly string[],
  limit = FILTER_RESULT_LIMIT,
): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const basenameMatches: string[] = [];
  const pathMatches: string[] = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    if (!lower.includes(q)) continue;
    const slash = lower.lastIndexOf('/');
    const basename = slash < 0 ? lower : lower.slice(slash + 1);
    if (basename.includes(q)) basenameMatches.push(f);
    else pathMatches.push(f);
    if (basenameMatches.length + pathMatches.length >= limit) break;
  }
  return [...basenameMatches, ...pathMatches];
}
