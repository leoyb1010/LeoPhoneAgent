import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const desktopDir = resolve(import.meta.dirname, "..");
const builderDir = dirname(require.resolve("app-builder-lib/package.json"));

it("compiles real UAC calls when the plugin directory follows the custom include", async (context) => {
  // NSIS 自带的 mac 编译器是 x86_64；Apple Silicon 缺少 Rosetta 时只跳过此环境不支持的编译测试。
  if (process.platform === "darwin" && process.arch === "arm64") {
    try {
      await execFileAsync("/usr/bin/arch", ["-x86_64", "/usr/bin/true"]);
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      if (stderr.includes("Bad CPU type in executable")) {
        context.skip("NSIS x86_64 compiler requires Rosetta on Apple Silicon");
        return;
      }
      throw error;
    }
  }
  const { NSIS_PATH, NSIS_RESOURCES_PATH, NsisTargetOptions } = require(
    resolve(builderDir, "out/targets/nsis/nsisUtil.js"),
  );
  NsisTargetOptions.resolve({});
  const [nsisDir, resourcesDir] = await Promise.all([NSIS_PATH(), NSIS_RESOURCES_PATH()]);
  const compiler = join(
    nsisDir,
    process.platform === "win32"
      ? "Bin/makensis.exe"
      : process.platform === "darwin"
        ? "mac/makensis"
        : "linux/makensis",
  );
  const temp = await mkdtemp(join(tmpdir(), "zcode-nsis-compile-"));
  try {
    // [leo] electron-builder 自带的 NSIS 3.0.4.1 mac 编译器（x86_64）在 macOS 27 的 Rosetta 下处理
    // `Unicode true` 即 std::bad_alloc 崩溃，与 installer.nsh 内容无关；先用最小脚本探测，编译器本身
    // 不可用时按环境不支持跳过，可用时仍走下面的真实编译断言。
    if (process.platform === "darwin") {
      const probe = join(temp, "probe.nsi");
      await writeFile(
        probe,
        `Unicode true\nName "probe"\nOutFile "${join(temp, "probe.exe")}"\nSection\nSectionEnd\n`,
      );
      try {
        await execFileAsync(compiler, ["-V1", probe], { env: { ...process.env, NSISDIR: nsisDir } });
      } catch (error) {
        const stderr = (error as { stderr?: string }).stderr ?? "";
        if (stderr.includes("std::bad_alloc")) {
          context.skip("bundled NSIS mac compiler crashes on Unicode scripts on this macOS");
          return;
        }
        throw error;
      }
    }
    for (const uninstaller of [false, true]) {
      const output = join(temp, uninstaller ? "uninstaller.exe" : "installer.exe");
      // 只编译不执行：载荷复用当前文件，所有平台都能验证真实 NSIS 插件解析。
      const args = [
        "-V2",
        ...(uninstaller ? ["-WX", "-DBUILD_UNINSTALLER"] : []),
        `-DNSIS_INCLUDE_DIR=${join(nsisDir, "Include")}`,
        `-DELECTRON_BUILDER_NSIS_INCLUDE_DIR=${join(builderDir, "templates/nsis/include")}`,
        `-DNSIS_PLUGIN_DIR=${join(resourcesDir, "plugins/x86-unicode")}`,
        `-DZCODE_INSTALLER_NSH=${join(desktopDir, "build/installer.nsh")}`,
        `-DFIXTURE_EXE=${import.meta.filename}`,
        `-DOUTPUT_FILE=${output}`,
        `-DDEFAULT_LOG_PATH=${join(temp, "default.log")}`,
        `-DELEVATED_LOG_PATH=${join(temp, "elevated.log")}`,
        join(desktopDir, "test/fixtures/installer-nsh-smoke.nsi"),
      ];
      await execFileAsync(compiler, args, { env: { ...process.env, NSISDIR: nsisDir } });
      expect((await stat(output)).size).toBeGreaterThan(0);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 120_000);
