#!/usr/bin/env node
/**
 * [leo] 上游同步的「删除面」：我们删掉的上游文件 / 目录清单与执行脚本。
 *
 * 清单在 scripts/leo-upstream-delete-list.txt（相对 src/mac/leophone）：
 *   - 一行一个路径；以 `/` 结尾表示整个目录（上游以后在该目录里新增的文件也一并删除）；
 *   - `#` 开头为注释。
 *
 * 用法（在 src/mac/leophone 下，subtree pull/merge 之后、解冲突之前）：
 *   node scripts/leo-upstream-delete.mjs --apply      # git rm 清单里仍存在的路径（含 modify/delete 冲突）
 *   node scripts/leo-upstream-delete.mjs --check      # 清单里有路径又冒出来就非零退出
 *   node scripts/leo-upstream-delete.mjs --generate <上游 commit>   # 按「上游有、我们没有」重新生成清单
 *
 * --generate 的口径：上游该版本存在、当前 HEAD 不存在的文件；整个目录都不在我们树里时折叠成 `dir/`。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const listPath = join(rootDir, "scripts/leo-upstream-delete-list.txt");

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    ...options,
  });
}

function readList() {
  return readFileSync(listPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/** 当前索引里（含未解决冲突）的路径，相对 src/mac/leophone。 */
function indexPaths() {
  const output = git(["ls-files", "-z", "--cached", "--", "."]);
  return [...new Set(output.split("\0").filter(Boolean))];
}

function matches(entry, path) {
  return entry.endsWith("/") ? path.startsWith(entry) : path === entry;
}

function presentEntries(entries) {
  const paths = indexPaths();
  const present = [];
  for (const entry of entries) {
    const hits = paths.filter((path) => matches(entry, path));
    const onDisk = !entry.endsWith("/") && existsSync(join(rootDir, entry));
    if (hits.length > 0 || onDisk) present.push({ entry, hits });
  }
  return present;
}

function apply() {
  const present = presentEntries(readList());
  let removed = 0;
  for (const { entry, hits } of present) {
    const targets = hits.length > 0 ? hits : [entry];
    // 分批，避免参数过长；--ignore-unmatch 兼容已删 / 冲突状态。
    for (let index = 0; index < targets.length; index += 200) {
      git(["rm", "-r", "-q", "-f", "--ignore-unmatch", "--", ...targets.slice(index, index + 200)]);
    }
    removed += targets.length;
    console.log(`[leo-upstream-delete] rm ${entry} (${targets.length})`);
  }
  console.log(`[leo-upstream-delete] 删除 ${removed} 个文件（清单命中 ${present.length} 条）`);
  return 0;
}

function check() {
  const present = presentEntries(readList());
  if (present.length === 0) {
    console.log("[leo-upstream-delete] ✓ 清单里的路径都不存在");
    return 0;
  }
  console.error("[leo-upstream-delete] ✗ 这些已删除的上游路径又出现了：");
  for (const { entry, hits } of present) console.error(`  ${entry} (${hits.length || 1})`);
  console.error("[leo-upstream-delete] 跑 --apply 删除，或确认需要保留后从清单里去掉。");
  return 1;
}

function generate(upstreamRef) {
  if (!upstreamRef) {
    console.error("用法：--generate <上游 subtree commit，例如 aac47556>");
    return 2;
  }
  const upstream = git(["ls-tree", "-r", "-z", "--full-tree", "--name-only", upstreamRef])
    .split("\0")
    .filter(Boolean);
  const ours = new Set(
    git(["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", "."]).split("\0").filter(Boolean),
  );
  const oursDirs = new Set();
  for (const path of ours) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) oursDirs.add(parts.slice(0, index).join("/"));
  }
  const missing = upstream.filter((path) => !ours.has(path));
  const entries = new Set();
  for (const path of missing) {
    const parts = path.split("/");
    let collapsed = null;
    // 最高一层「整个目录都不在我们树里」的祖先目录
    for (let index = 1; index < parts.length; index += 1) {
      const dir = parts.slice(0, index).join("/");
      if (!oursDirs.has(dir)) {
        collapsed = `${dir}/`;
        break;
      }
    }
    entries.add(collapsed ?? path);
  }
  const header = [
    "# [leo] 上游同步时按删除处理的路径（相对 src/mac/leophone），由",
    `#   node scripts/leo-upstream-delete.mjs --generate ${upstreamRef}`,
    "# 生成：上游该版本存在、我们树里不存在的文件；整个目录都没有时折叠成 `dir/`（以后上游在其中新增的文件也删）。",
    "# 执行：subtree merge 之后跑 --apply；收尾跑 --check。删除理由见 docs/mac-3.0/UPSTREAM.md。",
    "",
  ];
  writeFileSync(listPath, `${header.join("\n")}${[...entries].sort().join("\n")}\n`);
  console.log(`[leo-upstream-delete] 生成 ${entries.size} 条（覆盖 ${missing.length} 个上游文件）`);
  return 0;
}

function main(argv) {
  if (argv.includes("--apply")) return apply();
  if (argv.includes("--generate")) return generate(argv[argv.indexOf("--generate") + 1]);
  return check();
}

process.exitCode = main(process.argv.slice(2));
