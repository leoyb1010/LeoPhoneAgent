import { CINDY_FILE_EXT } from '../../shared/ghost.js';

/**
 * 从启动参数里找双击关联而来的 .cindy 文件路径(双击装入)。
 *
 * Windows 双击已关联的 .cindy 时,OS 把文件路径追加到 argv 末尾(冷启动进
 * process.argv,已运行则经单例锁转为 second-instance 的 argv)。从后往前找
 * 第一个以 .cindy 结尾、且不是 --flag 形态的参数;找不到返回 null。
 * 纯函数,零 electron 依赖,单测直测。
 */
export function findCindyFileInArgv(argv: string[]): string | null {
  for (let i = argv.length - 1; i >= 1; i--) {
    const arg = argv[i];
    if (!arg || arg.startsWith('-')) continue;
    if (arg.toLowerCase().endsWith(CINDY_FILE_EXT)) return arg;
  }
  return null;
}
