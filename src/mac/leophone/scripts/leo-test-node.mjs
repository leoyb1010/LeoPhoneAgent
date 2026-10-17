#!/usr/bin/env node
// [leo] 跑 Leo 自有的 node:test 用例（vitest 收不到的那批：desktop/src 与 test、services/test 的 Leo 文件、
// packages/ui/test 的 Leo 文件）。每组都先加载测试 HOME 隔离（scripts/test-isolation/home.mjs）。
// ui 的用例依赖 `@/` 别名，必须在 packages/ui 目录下运行。
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isolation = join(root, "scripts/test-isolation/home.mjs");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "e2e" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const isNodeTest = (file) => /from ["']node:test["']/.test(readFileSync(file, "utf8"));

const groups = [
  { cwd: root, dirs: ["packages/desktop/src", "packages/desktop/test", "packages/services/test"] },
  { cwd: join(root, "packages/ui"), dirs: ["test", "src"] },
];

let failed = false;
for (const group of groups) {
  const files = group.dirs
    .flatMap((dir) => walk(join(group.cwd, dir)))
    .filter(isNodeTest)
    .map((file) => relative(group.cwd, file));
  if (files.length === 0) continue;
  console.log(`[leo-test-node] ${relative(root, group.cwd) || "."}: ${files.length} files`);
  const result = spawnSync(process.execPath, ["--import", isolation, "--import", "tsx", "--test", ...files], {
    cwd: group.cwd,
    stdio: "inherit",
  });
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
