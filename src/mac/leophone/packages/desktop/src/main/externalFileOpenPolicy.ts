import type { Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, extname, normalize } from "node:path";

/**
 * [leo] 打开本地文件前的判定（契约见 docs/specs/desktop-renderer-boundary.md §2）。
 *
 * 根因：OpenExternalFile / OpenExternal(file:) / OpenInFileManager 原先只做 realpath 就直接 shell.openPath，
 * realpath 失败还会拿原路径继续打开。macOS 上 openPath 一个 .app / .command / .pkg 等于启动或安装，
 * 渲染进程（模型输出可影响）就能借它执行任意程序。
 *
 * 规则：真实路径解析失败就不打开；真实目标或调用方给的名字命中应用包 / 可执行 / 安装包 / 脚本 / 快捷方式，
 * 或是 POSIX 平台带执行位的普通文件，就改为在访达里选中显示；普通文档、目录照常打开。
 */

/** macOS 上 open 一个目录也会启动或加载的包类型。 */
const LAUNCHABLE_BUNDLE_EXTENSIONS = new Set([
  ".app",
  ".appex",
  ".prefpane",
  ".bundle",
  ".framework",
  ".plugin",
  ".kext",
  ".systemextension",
  ".xpc",
  ".saver",
  ".qlgenerator",
  ".mdimporter",
  ".osax",
  ".component",
  ".workflow",
  ".action",
  ".scptd",
  ".wdgt",
]);

/** 交给默认应用会执行、安装或跳转的文件类型（三平台一起列，跨平台语义一致）。 */
const EXECUTABLE_FILE_EXTENSIONS = new Set([
  ".command",
  ".tool",
  ".terminal",
  ".sh",
  ".bash",
  ".zsh",
  ".csh",
  ".ksh",
  ".fish",
  ".scpt",
  ".applescript",
  ".pkg",
  ".mpkg",
  ".dmg",
  ".jar",
  ".jnlp",
  ".webloc",
  ".inetloc",
  ".fileloc",
  ".url",
  ".desktop",
  ".exe",
  ".msi",
  ".msix",
  ".appx",
  ".bat",
  ".cmd",
  ".com",
  ".scr",
  ".ps1",
  ".vbs",
  ".vbe",
  ".js",
  ".jse",
  ".wsf",
  ".wsh",
  ".hta",
  ".lnk",
  ".reg",
  ".cpl",
  ".appimage",
  ".run",
  ".deb",
  ".rpm",
]);

export type ExternalOpenTarget =
  | { kind: "missing"; requested: string }
  | { kind: "open"; path: string; isDirectory: boolean }
  | { kind: "reveal"; path: string; reason: "launchable" };

function hasDangerousExtension(path: string): boolean {
  const extension = extname(basename(path)).toLowerCase();
  return LAUNCHABLE_BUNDLE_EXTENSIONS.has(extension) || EXECUTABLE_FILE_EXTENSIONS.has(extension);
}

function isPosixExecutable(info: Stats): boolean {
  // 有扩展名也可能被系统关联启动；执行位不是无扩展名文件才有的权限。
  return process.platform !== "win32" && info.isFile() && (info.mode & 0o111) !== 0;
}

/**
 * 解析调用方给的路径并分类。symlink 按真实目标判定，调用方给的名字也一起检查
 * （例如指向无扩展名可执行文件的 report.command 链接，两边任一命中就不打开）。
 */
export async function resolveExternalOpenTarget(rawPath: string): Promise<ExternalOpenTarget> {
  const requested = normalize(rawPath.trim());
  let target: string;
  try {
    target = await realpath(requested);
  } catch {
    return { kind: "missing", requested };
  }
  let info: Stats;
  try {
    info = await stat(target);
  } catch {
    return { kind: "missing", requested };
  }
  if (
    hasDangerousExtension(target) ||
    hasDangerousExtension(requested) ||
    isPosixExecutable(info)
  ) {
    return { kind: "reveal", path: target, reason: "launchable" };
  }
  return { kind: "open", path: target, isDirectory: info.isDirectory() };
}
