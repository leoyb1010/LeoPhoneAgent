/** 普通 hotfix 在 userData/updates 下的清理原语。 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 清理普通 hotfix 文件，只保留当前文件及其 sidecar；子目录属于其它更新
 * 流程的命名空间，永不递归或删除。
 */
export function cleanOldUpdateFiles(
  updatesDir: string,
  keepFileName: string,
  persistentFileNames: readonly string[],
): void {
  const keepSet = new Set([
    keepFileName,
    `${keepFileName}.part`,
    `${keepFileName}.meta.json`,
    `${keepFileName}.meta.json.tmp`,
    ...persistentFileNames,
  ]);
  for (const entry of fs.readdirSync(updatesDir, { withFileTypes: true })) {
    if (entry.isDirectory() || keepSet.has(entry.name)) continue;
    try {
      fs.unlinkSync(path.join(updatesDir, entry.name));
    } catch {
      // 清理是 best-effort；下载器会自行处理当前目标文件的完整性。
    }
  }
}
