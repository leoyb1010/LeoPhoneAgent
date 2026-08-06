/**
 * workdirPath — workdir 相对路径换算的纯字符串工具(renderer / main 共用)。
 * ---------------------------------------------------------------------------
 * 远程会话链路里「远端绝对路径 → workdir 相对 POSIX 路径」在多处需要:
 *   - main 的 chat-file 编排(fetch / stat 前算 relPath);
 *   - renderer 的目录 chip 点击(把目录定位进侧边栏文件浏览器需要 relPath)。
 * 单一实现避免两侧 Windows 归一 / `..` 拒绝 / `.` 段处理各自漂移。
 * 无 node:path 依赖,双环境可用;不触文件系统。
 */

const WIN_ABS_RE = /^[A-Za-z]:[\\/]/;

/** 去掉路径里的 `.` 段(`/w/./a` → `/w/a`):renderer 的 join 会保留 `./` 前缀,
 *  不归一会让缓存 identity / file-service relPath 出现同路径两形态。 */
export function dropDotSegments(p: string): string {
  const isAbs = p.startsWith('/');
  const segs = p.split('/').filter((s) => s !== '.' && s !== '');
  return (isAbs ? '/' : '') + segs.join('/');
}

/** POSIX:绝对路径 → workdir 相对路径;不在 workdir 内(含 workdir 自身)/
 *  `..` 逃逸 / 非绝对 → null。 */
export function toWorkdirRelPosix(workdir: string, absPath: string): string | null {
  if (!workdir.startsWith('/') || !absPath.startsWith('/')) return null;
  if (absPath.split('/').includes('..')) return null;
  const base = workdir.replace(/\/+$/, '');
  if (!absPath.startsWith(`${base}/`)) return null;
  const rel = absPath.slice(base.length + 1);
  return rel.length > 0 ? rel : null;
}

/**
 * 绝对路径 → workdir 相对路径(POSIX 分隔),不在 workdir 内 / `..` 逃逸 / 风格
 * 不匹配 → null。Windows 风格(device 被控端)按大小写不敏感前缀比较,输出仍
 * 统一 POSIX 分隔(file-browser 全链路的 relPath 约定)。`.` 段一律归一掉。
 */
export function toWorkdirRel(workdir: string, absPath: string): string | null {
  if (!workdir || !absPath) return null;
  if (workdir.startsWith('/')) {
    return toWorkdirRelPosix(workdir, dropDotSegments(absPath));
  }
  if (!WIN_ABS_RE.test(workdir) || !WIN_ABS_RE.test(absPath)) return null;
  const w = workdir.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = dropDotSegments(absPath.replace(/\\/g, '/'));
  if (a.split('/').includes('..')) return null;
  if (!a.toLowerCase().startsWith(`${w.toLowerCase()}/`)) return null;
  const rel = a.slice(w.length + 1);
  return rel.length > 0 ? rel : null;
}
