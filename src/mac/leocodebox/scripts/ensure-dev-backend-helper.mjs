import { copyFileSync, existsSync, lstatSync, linkSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/**
 * desktop:dev 的服务端必须从 LSUIElement helper 启动。
 * 二进制如果只是 symlink 到 Electron.app,tsx 再拉子进程时 execPath
 * 会解析成 Electron.app,LaunchServices 又往 Dock 挂一只没名字的黑块。
 * 硬链接(失败则复制)让进程路径停在 helper 包里。
 */
export function ensureDevBackendHelper(projectRoot) {
  const electronApp = path.join(projectRoot, 'node_modules/electron/dist/Electron.app');
  const electronBin = path.join(electronApp, 'Contents/MacOS/Electron');
  const electronFw = path.join(electronApp, 'Contents/Frameworks');
  const contents = path.join(projectRoot, 'scripts/dev-backend.app/Contents');
  const helperBin = path.join(contents, 'MacOS/dev-backend');
  const helperFw = path.join(contents, 'Frameworks');

  if (!existsSync(electronBin) || !existsSync(electronFw)) {
    throw new Error(`Electron runtime missing at ${electronApp}`);
  }

  mkdirSync(path.dirname(helperBin), { recursive: true });
  try {
    unlinkSync(helperBin);
  } catch {
    // first run
  }
  try {
    linkSync(electronBin, helperBin);
  } catch {
    copyFileSync(electronBin, helperBin);
  }

  try {
    rmSync(helperFw, { recursive: true, force: true });
  } catch {
    // first run
  }
  symlinkSync(electronFw, helperFw);

  const helperStat = lstatSync(helperBin);
  if (helperStat.isSymbolicLink()) {
    throw new Error('dev-backend helper must not be a symlink to Electron.app');
  }
  return helperBin;
}
