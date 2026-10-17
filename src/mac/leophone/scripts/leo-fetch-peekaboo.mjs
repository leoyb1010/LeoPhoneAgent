#!/usr/bin/env node
// [leo][WP-22] 取随包的 Peekaboo CLI(openclaw/Peekaboo,MIT)到 packages/desktop/leo/bin/。
//
// - 版本与哈希钉在这里:tarball 的 sha256 与解包后两个文件各自的 sha256 都要对上,任何一个不符就失败,
//   不会把不认识的二进制放进安装包。升级 = 改下面几个常量(从 Release 的 checksums.txt / SIGNING-MANIFEST.json 抄)。
// - 已经在位且哈希一致就什么也不做(离线也能过);--force 重新下载。
// - 上游二进制是 OpenClaw 的 Developer ID 签名 + 公证;打包时 electron-builder 会对 Resources/leo/bin 里的
//   Mach-O 用 LeoBot 的 Developer ID + hardened runtime 重签(不在 signIgnore 里),所以这里不动签名。
// - 用 curl 下载(跟随系统 / 环境代理);只连 github.com 与它的 release 资产域名。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "4.9.4";
// 只装 Apple 芯片机器:用 arm64 单架构包,比 universal 小一半,也不带用不上的 x86_64 切片。
const ARCH_DIR = "peekaboo-macos-arm64";
const ASSET = `${ARCH_DIR}.tar.gz`;
const ASSET_SHA256 = "a1d04316c526a5f1b933b16d284d05ff0c4b95e4f640939b1703fa36b2c461b9";
const FILES = {
  peekaboo: "be3313c3dcafe7ccf3ad16f0f48b5471cd228d7ba4650ec776e4da36fb5f0068",
  // peekaboo 经 @rpath(@loader_path)加载它,必须放同一目录。
  "libswiftCompatibilitySpan.dylib": "892792bc147a56c558f7dae1930bad249cd5abac6483a3ae1281d2f6fccb905c",
};
const URL = `https://github.com/openclaw/Peekaboo/releases/download/v${VERSION}/${ASSET}`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "packages", "desktop", "leo", "bin");
const force = process.argv.includes("--force");

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const inPlace = () =>
  Object.entries(FILES).every(([name, digest]) => {
    const path = join(outDir, name);
    return existsSync(path) && sha256(path) === digest;
  });

if (process.platform !== "darwin") {
  console.log("[peekaboo] 跳过:只有 macOS 包随带 Peekaboo");
  process.exit(0);
}
if (!force && inPlace()) {
  console.log(`[peekaboo] ${VERSION} 已在 ${outDir},哈希一致`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "leo-peekaboo-"));
try {
  const archive = join(work, ASSET);
  console.log(`[peekaboo] 下载 ${URL}`);
  execFileSync("curl", ["-fsSL", "--retry", "3", "-o", archive, URL], { stdio: "inherit" });
  const got = sha256(archive);
  if (got !== ASSET_SHA256) throw new Error(`tarball sha256 不符:${got},应为 ${ASSET_SHA256}`);
  const extracted = join(work, "x");
  mkdirSync(extracted);
  execFileSync("tar", ["-xzf", archive, "-C", extracted]);
  const sourceDir = join(extracted, ARCH_DIR);
  mkdirSync(outDir, { recursive: true });
  for (const [name, digest] of Object.entries(FILES)) {
    const source = join(sourceDir, name);
    const actual = sha256(source);
    if (actual !== digest) throw new Error(`${name} sha256 不符:${actual},应为 ${digest}`);
    copyFileSync(source, join(outDir, name));
    chmodSync(join(outDir, name), 0o755);
  }
  copyFileSync(join(sourceDir, "LICENSE"), join(outDir, "PEEKABOO-LICENSE"));
  console.log(`[peekaboo] ${VERSION} 已放到 ${outDir}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
