#!/usr/bin/env node
// [up-p0-gates] vitest 已知失败棘轮。
//
// 全量 `pnpm test:unit` 长期有一批已知失败,直接把它挂进 CI 会永远红,于是一直没挂 ——
// 结果是新增的失败也没人拦。棘轮的规则:
//   * 失败的测试必须在 leo-vitest-known-failures.json 里,否则 exit 1(新失败);
//   * 基线里的测试现在通过了,会列出来,用 --update 从基线里删掉(只删不加);
//   * 只有显式 --accept-new 才会把新失败写进基线。
//
// 用法(在 src/mac/leophone 下):
//   node scripts/leo-vitest-ratchet.mjs                    # 跑全量 vitest 并对比基线
//   node scripts/leo-vitest-ratchet.mjs --report r.json    # 用已有的 vitest JSON 报告
//   node scripts/leo-vitest-ratchet.mjs --update           # 删掉已修好的基线条目
//   node scripts/leo-vitest-ratchet.mjs --update --accept-new   # 连新失败一起写进基线(慎用)
//   node scripts/leo-vitest-ratchet.mjs --related a.ts b.ts     # 只跑 import 了这些文件的测试(pre-push 用)
//
// 新失败会先单独重跑一次所在文件;重跑通过的记为 flaky(打印,不拦),仍失败的才拦。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const BASELINE = join(ROOT, "scripts/leo-vitest-known-failures.json");
const VITEST = join(ROOT, "node_modules/.bin/vitest");
const BASE_ARGS = ["run", "--exclude", "packages/desktop/test/e2e/**/*.test.ts"];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const update = flag("--update");
// --related 之后的参数都是改动过的源文件(相对 src/mac/leophone)。
const relatedAt = argv.indexOf("--related");
const related = relatedAt >= 0 ? argv.slice(relatedAt + 1) : null;
const acceptNew = flag("--accept-new");
if (acceptNew && !update) {
  console.error("leo-vitest-ratchet: --accept-new 只能和 --update 一起用");
  process.exit(2);
}
if (related && update) {
  console.error("leo-vitest-ratchet: --update 只能在全量运行时用(--related 看不到全部基线)");
  process.exit(2);
}

function runVitest(files, mode = "run") {
  if (!existsSync(VITEST)) {
    console.error(`leo-vitest-ratchet: 找不到 ${VITEST}(先 pnpm install)`);
    process.exit(2);
  }
  const dir = mkdtempSync(join(tmpdir(), "leo-vitest-ratchet-"));
  const out = join(dir, "report.json");
  const res = spawnSync(
    VITEST,
    [mode, ...BASE_ARGS.slice(1), ...(mode === "related" ? ["--run"] : []), "--reporter=dot", "--reporter=json", `--outputFile.json=${out}`, ...files],
    { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] },
  );
  if (!existsSync(out)) {
    console.error(`leo-vitest-ratchet: vitest 没有产出 JSON 报告(exit ${res.status}, signal ${res.signal})`);
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(out, "utf8"));
  rmSync(dir, { recursive: true, force: true });
  return report;
}

// 测试标识:<相对路径> > <describe 链 + 用例名>;文件整体加载失败记为 <相对路径> > (file)。
function failingIds(report) {
  const ids = new Set();
  for (const file of report.testResults ?? []) {
    const rel = relative(ROOT, file.name);
    const failed = (file.assertionResults ?? []).filter((a) => a.status === "failed");
    for (const a of failed) ids.add(`${rel} > ${a.fullName}`);
    if (file.status === "failed" && failed.length === 0) ids.add(`${rel} > (file)`);
  }
  return ids;
}

const fileOf = (id) => id.slice(0, id.indexOf(" > "));
const pkgOf = (id) => fileOf(id).split("/").slice(0, 2).join("/");

function byPackage(ids) {
  const counts = {};
  for (const id of ids) counts[pkgOf(id)] = (counts[pkgOf(id)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort());
}

function writeBaseline(ids) {
  const failures = [...ids].sort();
  const body = {
    _comment:
      "vitest 已知失败基线(scripts/leo-vitest-ratchet.mjs)。只许变短:修好一个就跑 --update 删掉;" +
      "新失败不许直接加进来(除非 --update --accept-new 并在提交里说明原因)。",
    total: failures.length,
    byPackage: byPackage(failures),
    failures,
  };
  writeFileSync(BASELINE, `${JSON.stringify(body, null, 2)}\n`);
}

const reportPath = opt("--report");
if (related && related.length === 0) {
  console.log("leo-vitest-ratchet: --related 没有给文件,无需运行");
  process.exit(0);
}
const report = reportPath
  ? JSON.parse(readFileSync(reportPath, "utf8"))
  : related
    ? runVitest(related, "related")
    : runVitest([]);
const total = report.numTotalTests ?? 0;
if (total === 0 && related) {
  console.log(`leo-vitest-ratchet: ${related.length} 个改动文件没有关联的 vitest 用例,本次没有评估任何测试`);
  process.exit(0);
}
if (total === 0) {
  // 空跑永远是绿的 —— 0 个测试按失败处理。
  console.error("leo-vitest-ratchet: vitest 一个测试都没跑到,按失败处理");
  process.exit(1);
}

const current = failingIds(report);
const baseline = new Set(existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")).failures : []);
let fresh = [...current].filter((id) => !baseline.has(id)).sort();
// --related 只跑了一部分文件:没跑到的基线条目不算"修好"。
const ranFiles = new Set((report.testResults ?? []).map((f) => relative(ROOT, f.name)));
const fixed = [...baseline]
  .filter((id) => !current.has(id) && (!related || ranFiles.has(fileOf(id))))
  .sort();

let flaky = [];
if (fresh.length > 0 && !reportPath) {
  const files = [...new Set(fresh.map(fileOf))];
  console.log(`\nleo-vitest-ratchet: ${fresh.length} 个新失败,单独重跑 ${files.length} 个文件确认…`);
  const again = failingIds(runVitest(files));
  flaky = fresh.filter((id) => !again.has(id));
  fresh = fresh.filter((id) => again.has(id));
}

console.log(`\nleo-vitest-ratchet: ${total} tests, ${current.size} failing, baseline ${baseline.size}`);
console.log(`  failing by package: ${JSON.stringify(byPackage(current))}`);
if (flaky.length) {
  console.log(`\n  FLAKY(首跑失败、重跑通过,未拦截)${flaky.length}:`);
  for (const id of flaky) console.log(`    ~ ${id}`);
}
if (fixed.length) {
  console.log(`\n  基线里已不再失败的 ${fixed.length} 个(跑 --update 从基线删掉):`);
  for (const id of fixed) console.log(`    - ${id}`);
}
if (fresh.length) {
  console.log(`\n  NEW FAILURES(不在基线里)${fresh.length}:`);
  for (const id of fresh) console.log(`    + ${id}`);
}

if (update) {
  const next = new Set([...baseline].filter((id) => current.has(id)));
  if (acceptNew) for (const id of fresh) next.add(id);
  writeBaseline(next);
  console.log(`\n  基线已写入 ${relative(ROOT, BASELINE)}:${baseline.size} -> ${next.size}`);
}

if (fresh.length && !(update && acceptNew)) {
  console.log("\nleo-vitest-ratchet: FAIL — 有不在基线里的新失败");
  process.exit(1);
}
console.log("\nleo-vitest-ratchet: OK — 没有基线之外的失败");
