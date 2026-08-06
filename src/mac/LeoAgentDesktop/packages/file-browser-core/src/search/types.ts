/**
 * Project-wide text search 共享类型。
 *
 * 数据流: render → invoke(start) → main spawn rg → ndjson parse →
 *         webContents.send(event) → render 累积渲染。
 *
 * 搜索范围固定为传入的 workdir;不支持 regex / replace / include-glob
 * (按 v1 设计稿要求精简)。
 */

export interface SearchQuery {
  /** Absolute workdir path. Searcher 不做工作目录解析,完全信任入参。 */
  workdir: string;
  /** 字面量查询字符串。rg 走 -F (fixed-string),不当正则。 */
  query: string;
  /** 默认 false (不区分大小写)。设计稿 Aa toggle 默认关闭。 */
  caseSensitive: boolean;
  /** 全局匹配数硬上限(到达后 kill 子进程并 emit truncated end)。 */
  maxMatches: number;
}

export interface SubmatchSpan {
  /** byte offset within the line (UTF-8 字节位置, rg 原样透传)。 */
  start: number;
  end: number;
}

export interface SearchMatch {
  searchId: string;
  /** workdir-relative POSIX path,主进程会把 rg 输出的绝对路径剥成相对。 */
  relPath: string;
  lineNumber: number;
  /** 整行原文(rg 已 trim 行尾换行)。 */
  lineText: string;
  /** 行内命中片段位置;一行可能多次命中。 */
  submatches: SubmatchSpan[];
}

export interface SearchEnd {
  searchId: string;
  /** 是否因为达到 maxMatches 上限而提前结束。 */
  truncated: boolean;
  /** rg 报告的累计文件数 / 累计匹配数(到提前结束为止)。 */
  totalMatches: number;
  totalFiles: number;
}

export interface SearchError {
  searchId: string;
  message: string;
}

export type SearchEvent =
  | ({ type: 'match' } & SearchMatch)
  | ({ type: 'end' } & SearchEnd)
  | ({ type: 'error' } & SearchError);
