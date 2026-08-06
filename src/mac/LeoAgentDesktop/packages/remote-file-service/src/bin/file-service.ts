/**
 * file-service.ts — daemon 生产入口(esbuild 打包为 dist/file-service.mjs)。
 *
 * 运行形态:desktop 经 SSH exec 启动
 *   `<bundled-node> file-service.mjs [--rg <path>]`
 * stdio 即 RPC 通道;stdin EOF(channel 关闭)即自然退出,无常驻状态。
 *
 * `--version`:一行 JSON(bundleVersion + schemaVersion),安装器 probe 用,
 * 与 cc-mgr.mjs --version 的约定一致。
 */

import {
  FILE_SERVICE_BUNDLE_VERSION,
  FILE_SERVICE_SCHEMA_VERSION,
} from '../protocol.js';
import { runFileService } from '../server.js';

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}

if (process.argv.includes('--version')) {
  process.stdout.write(
    `${JSON.stringify({
      bundleVersion: FILE_SERVICE_BUNDLE_VERSION,
      schemaVersion: FILE_SERVICE_SCHEMA_VERSION,
    })}\n`,
  );
  process.exit(0);
}

void runFileService(process.stdin, process.stdout, {
  rgPath: argValue('--rg'),
}).then(() => {
  process.exit(0);
});
