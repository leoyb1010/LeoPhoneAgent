import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

// 主工程当前 main/preload tsconfig 的跨 rootDir 历史问题不能掩盖新增原生边界。
// 此检查使用真实 Electron/Node 类型与真实共享 channel 源码，不替换运行时实现。
const root = process.cwd();
const folder = await mkdtemp(join(tmpdir(), "paperclip-transport-"));
try {
  const config = join(folder, "tsconfig.json");
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: {
        target: "es2024",
        module: "nodenext",
        moduleResolution: "nodenext",
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        noUncheckedIndexedAccess: true,
        types: ["node"],
        typeRoots: [resolve(root, "node_modules/@types")],
        paths: { "@zcode/shared": [resolve(root, "packages/shared/src/channels.ts")] },
      },
      files: [resolve(root, "packages/desktop/src/main/paperclip/transport.ts")],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [resolve(root, "node_modules/typescript/bin/tsc"), "-p", config],
    { stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
} finally {
  await rm(folder, { recursive: true, force: true });
}
