/**
 * CSS font-family 值到 UI 展示值的纯转换工具。
 *
 * - unquoteFontFamily:剥掉外层引号 + 反转义,用于在
 *   UI(如字体下拉的触发按钮)上显示干净的字体名,避免把存储值里的字面引号露出来。
 *
 * 抽成独立纯模块是为了可单测,不引入 React / DOM 依赖。
 */

function isWrappedInQuotes(value: string): boolean {
  return (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  );
}

/** 剥掉外层引号并反转义,得到可读字体名;未加引号的值原样返回。 */
export function unquoteFontFamily(value: string): string {
  const trimmed = value.trim();
  if (!isWrappedInQuotes(trimmed)) return trimmed;
  return trimmed.slice(1, -1).replace(/\\(["'\\])/g, '$1');
}
