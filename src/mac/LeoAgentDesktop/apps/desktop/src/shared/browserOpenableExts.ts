/**
 * browserOpenableExts — 用于"在浏览器中查看"菜单项的文件扩展名白名单。
 *
 * 产品语义:只给 HTML 文件显示此项。Markdown / 代码 / 图片等在应用内已有预览,
 * 不应再出现"在浏览器中查看"。
 *
 * 不收录:md / pdf / svg / 图片 / 文本 / docx / zip / dmg / exe 等。
 *
 * 同时在 main 和 renderer 消费(renderer 决定要不要显示菜单项, main 在
 * shell:open-file-in-browser 里做防御性校验), 所以放 shared。
 */

/** 允许通过系统浏览器查看的扩展名(全部小写, 带 leading dot)。*/
export const BROWSER_OPENABLE_EXTS = new Set<string>(['.html', '.htm']);

/**
 * 判断一个文件路径是否值得显示"在浏览器中查看"菜单项。
 * 只看扩展名(小写化), 不做 fs 检查。空路径 / 无扩展名 → false。
 */
export function isBrowserOpenablePath(filePath: string): boolean {
  if (!filePath) return false;
  // 取最后一个 '.' 之后的部分; 路径分隔符两种都兼容
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const name = lastSep >= 0 ? filePath.slice(lastSep + 1) : filePath;
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx <= 0) return false; // 无扩展名 或 隐藏文件(.gitignore 那种)
  const ext = name.slice(dotIdx).toLowerCase();
  return BROWSER_OPENABLE_EXTS.has(ext);
}
