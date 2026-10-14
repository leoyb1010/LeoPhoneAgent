import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// [leo] 1.9.0：agent 打包（esbuild）对 `@zcode/shared` 做前缀 alias，新增的 shared 子路径若没在
// resolveBuildAliases 里精确声明，会被拼成 `src/index.ts/<subpath>`，直到出包那一步才失败
// （1.9.0 的 model-discovery 就是这样被 bootstrap 拦下的）。这里在单测阶段提前拦住。
const here = fileURLToPath(new URL(".", import.meta.url));
const appRoot = resolve(here, "../../../../../..");

async function* walk(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !/\.test\./.test(entry.name)) yield full;
  }
}

test("every @zcode/shared subpath used by agent-bundled sources has an exact build alias", async () => {
  const { resolveBuildAliases } = await import(
    resolve(appRoot, "apps/zcode-cli/packages/cli/scripts/build.mjs")
  );
  const aliases = resolveBuildAliases() as Record<string, string>;
  const roots = [
    resolve(appRoot, "packages/provider/src"),
    resolve(appRoot, "packages/provider-node/src"),
  ];
  const cliPackages = resolve(appRoot, "apps/zcode-cli/packages");
  // node-repl-host 有自己的 scripts/build.mjs，不走这里的 alias 表。
  for (const name of await readdir(cliPackages)) {
    if (name !== "node-repl-host") roots.push(join(cliPackages, name, "src"));
  }

  const used = new Map<string, string>();
  for (const root of roots) {
    try {
      for await (const file of walk(root)) {
        const text = await readFile(file, "utf8");
        // 只看会留在产物里的值导入；`import type` / `export type` 会被 esbuild 擦掉。
        const statements = /\b(import|export)\s+(type\s+)?[^;]*?\bfrom\s+["'](@zcode\/shared\/[A-Za-z0-9-]+)["']/g;
        for (const match of text.matchAll(statements)) {
          if (match[2] || used.has(match[3])) continue;
          used.set(match[3], file);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const missing = [...used].filter(([specifier]) => !(specifier in aliases));
  assert.deepEqual(
    missing.map(([specifier, file]) => `${specifier} (${file.slice(appRoot.length + 1)})`),
    [],
  );
});
