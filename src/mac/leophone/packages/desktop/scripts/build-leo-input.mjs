#!/usr/bin/env node
// [leo][WP-52] 编译远程操控输入助手 native/leo-input/main.swift → resources/leo-input/leo-input(arm64)。
//
// 仿 build-macos-window-bounds.mjs:非 darwin 跳过;缺 swiftc 只警告不失败 —— 没有它「允许手机操控」
// 会显示「不可用」,其它功能照常,不该让整个构建挂掉。target 与语音助手一致(macos26)。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(packageRoot, "native", "leo-input", "main.swift");
const outputDir = join(packageRoot, "resources", "leo-input");
const outputPath = join(outputDir, "leo-input");

if (process.platform !== "darwin") {
  console.log("[leo-input] 跳过:仅 macOS 需要");
  process.exit(0);
}
if (!existsSync(sourcePath)) {
  console.error(`[leo-input] 源文件缺失:${sourcePath}`);
  process.exit(1);
}
try {
  execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
} catch {
  console.warn("[leo-input] 未找到 swiftc(需 Xcode Command Line Tools);跳过,手机操控将不可用。");
  process.exit(0);
}

mkdirSync(outputDir, { recursive: true });
// 先删旧产物:编译失败时不能留下上一版二进制冒充新代码。
rmSync(outputPath, { force: true });
try {
  // 只构建 arm64:LeoBot 的 Mac 全部是 Apple 芯片(与随包 Peekaboo 同口径),省一半编译时间与体积。
  execFileSync(
    "xcrun",
    ["swiftc", "-O", "-target", "arm64-apple-macos26", sourcePath, "-o", outputPath],
    {
      stdio: "inherit",
    },
  );
  console.log(`[leo-input] 已构建 arm64 二进制:${outputPath}`);
} catch (error) {
  console.warn(
    "[leo-input] 构建失败,手机操控将不可用:",
    error instanceof Error ? error.message : String(error),
  );
}
