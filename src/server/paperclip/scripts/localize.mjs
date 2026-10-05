#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { extract, extractDynamic, transform, translationFor, sha256 } from './localization-engine.mjs';
import { applyStructuralPatches, loadStructuralPatches } from './structural-patches.mjs';

const home = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(home, 'upstream.lock.json')));
const [command, sourceArg, reportArg] = process.argv.slice(2);
if (!['extract', 'apply', 'verify'].includes(command) || !sourceArg) {
  console.error('用法：node scripts/localize.mjs <extract|apply|verify> <Paperclip 源码目录> [报告目录]'); process.exit(2);
}
const root = fs.realpathSync(sourceArg);
const statePath = path.join(root, ".leophone-zh-overlay.json");
const previousState = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath)) : { files: {} };
if (previousState.commit && previousState.commit !== lock.commit) throw new Error("旧中文输出状态不属于锁定提交");
const reportDir = path.resolve(reportArg || path.join(home, 'reports'));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (head !== lock.commit) throw new Error(`上游版本不匹配：需要 ${lock.commit}，实际 ${head}。拒绝猜测性应用。`);
const catalog = {};
for (const file of fs.readdirSync(path.join(home, 'catalogs')).filter(f => f.endsWith('.zh-CN.json')).sort()) {
  const values = JSON.parse(fs.readFileSync(path.join(home, 'catalogs', file)));
  for (const [en, zh] of Object.entries(values)) {
    if (!en.trim() || typeof zh !== 'string' || !zh.trim()) throw new Error(`无效词条：${file} ${en}`);
    if (Object.hasOwn(catalog, en) && catalog[en] !== zh) throw new Error(`词条冲突：${en}: ${catalog[en]} / ${zh}`);
    catalog[en] = zh;
  }
}
const contextPath = path.join(home, "catalogs/contexts.json");
const contexts = fs.existsSync(contextPath) ? JSON.parse(fs.readFileSync(contextPath)) : {};
const preservePath = path.join(home, "catalogs/preserve.json");
const preserve = fs.existsSync(preservePath) ? JSON.parse(fs.readFileSync(preservePath)) : {};
// 1.1.6：按 catalogs/order.json 的显式顺序应用，缺失/未知/冲突即失败。
const sourcePatches = loadStructuralPatches(path.join(home, "catalogs"));
for (const patch of sourcePatches) {
  if (typeof patch.file !== "string" || !patch.file.startsWith("ui/src/") || patch.file.includes("..") || typeof patch.from !== "string" || !patch.from.length || typeof patch.to !== "string" || !Number.isInteger(patch.expected ?? 1) || (patch.expected ?? 1) < 1) throw new Error("无效结构补丁：必须有固定源码路径、非空上下文和正整数匹配次数");
}
for (const [file, values] of Object.entries(contexts)) {
  if (!file.startsWith("ui/src/") || file.includes("..") || !values || typeof values !== "object" || Object.values(values).some(value => typeof value !== "string")) throw new Error(`无效上下文词库：${file}`);
}
for (const [text, entry] of Object.entries(preserve)) {
  if (!text || !entry.reason || !Array.isArray(entry.files) || entry.files.some(file => typeof file !== "string" || !file.startsWith("ui/src/") || file.includes(".."))) throw new Error(`无效技术保留记录：${text}`);
}
const files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', 'ui/src'], { cwd: root, encoding: 'utf8' })
  .trim().split('\n').filter(file => /\.(?:tsx|ts)$/.test(file) && !/(?:\.test\.|\.fixtures?\.|UxLab|Perf|DesignGuide)/.test(file));
for (const patch of sourcePatches) if (!files.includes(patch.file)) throw new Error(`补丁目标未纳入固定源码扫描：${patch.file}`);
const report = { sourcePatchSites: sourcePatches.reduce((n, p) => n + (p.expected ?? 1), 0), upstream: lock, catalogEntries: Object.keys(catalog).length, scope: 'AST-identifiable static UI text; not all English in the source tree', files: {}, totals: { candidates: 0, translated: 0, remaining: 0, preserved: 0, dynamicRemaining: 0, prelocalized: 0 }, structuralFiles: [] };
const changed = new Map();
const translatedUniqueStrings = new Set();
const baseline = {};
const baselinePath = path.join(home, 'source-contract.json');
const known = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath)) : {};
for (const file of files) {
  // Always use the pinned committed input. Applied overlays can be verified or
  // regenerated without double translation, but local edits are never overwritten.
  const source = execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 20_000_000 });
  let input = source;
  for (const patch of sourcePatches.filter(p => p.file === file)) {
    const count = input.split(patch.from).length - 1;
    if (count !== (patch.expected ?? 1)) throw new Error(`结构词条上下文不匹配：${file}: ${patch.from}`);
    input = input.split(patch.from).join(patch.to);
  }
  const fileContext = { ...Object.fromEntries(Object.entries(preserve).filter(([, entry]) => entry.files.includes(file)).map(([text]) => [text, text])), ...(contexts[file] ?? {}) };
  const result = transform(input, file, catalog, fileContext);
  for (const edit of result.edits) translatedUniqueStrings.add(edit.text);
  baseline[file] = sha256(source);
  if (known[file] && known[file] !== baseline[file]) throw new Error(`源文件指纹不匹配：${file}`);
  if (!result.entries.length && result.output === source) continue;
  const dynamicRemaining = extractDynamic(result.output, file);
  const preserved = result.entries.filter(e => translationFor(e, catalog, fileContext) === e.text).map(({ text, line }) => ({ text, line }));
  const prelocalized = result.entries.filter(e => translationFor(e, catalog, fileContext) === undefined && /[\u3400-\u9fff]/.test(e.text)).map(({ text, line }) => ({ text, line }));
  const remaining = result.entries.filter(e => translationFor(e, catalog, fileContext) === undefined && !/[\u3400-\u9fff]/.test(e.text)).map(({ text, line }) => ({ text, line }));
  report.files[file] = { candidates: result.entries.length, translated: result.edits.length, preserved, remaining, dynamicRemaining, prelocalized, sourcePatchSites: sourcePatches.filter(p => p.file === file).reduce((n, p) => n + (p.expected ?? 1), 0), sourceSha256: sha256(source) };
  report.totals.candidates += result.entries.length;
  report.totals.translated += result.edits.length;
  report.totals.remaining += remaining.length;
  report.totals.preserved += preserved.length;
  report.totals.prelocalized += prelocalized.length;
  report.totals.dynamicRemaining += dynamicRemaining.length;
  if (result.output !== source) changed.set(file, result.output);
}
report.translatedUniqueStrings = translatedUniqueStrings.size;
applyStructuralPatches({ root, changed, report });
// Inventory the final source, including locale and display-boundary overlays.
report.totals.dynamicRemaining = 0;
for (const [file, row] of Object.entries(report.files)) {
  if (changed.has(file)) row.dynamicRemaining = extractDynamic(changed.get(file), file);
  report.totals.dynamicRemaining += row.dynamicRemaining.length;
}
if (Object.keys(known).length && JSON.stringify(Object.keys(known).sort()) !== JSON.stringify(Object.keys(baseline).sort())) throw new Error("源码指纹清单不完整：请审核固定提交的全部扫描文件");
// When a catalogue or safety rule removes a previous translation, restore only
// our own hash-matching generated output. Never strand stale localized code.
for (const file of Object.keys(previousState.files ?? {})) {
  if (!file.startsWith("ui/") || file.includes("..") || !/^[a-f0-9]{64}$/.test(previousState.files[file])) throw new Error("中文输出状态记录无效");
  if (!changed.has(file)) {
    const original = execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 20_000_000 });
    changed.set(file, original);
  }
}
// 1.1.6：与 apply-native-cli-auth 一致，目标文件及其最近的已存在父目录都必须是物理路径，
// 防止通过符号链接父目录把写入导向固定源码树之外。
function assertPhysicalDestination(file) {
  const dest = path.join(root, file);
  if (fs.existsSync(dest) && fs.lstatSync(dest).isSymbolicLink()) throw new Error(`拒绝通过符号链接写入：${file}`);
  let parent = path.dirname(dest);
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  if (fs.realpathSync(parent) !== parent || !(parent === root || parent.startsWith(root + path.sep))) throw new Error(`拒绝通过符号链接父目录写入：${file}`);
}
for (const [file, output] of changed) {
  const dest = path.join(root, file);
  assertPhysicalDestination(file);
  const current = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
  let original = null;
  try { original = execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 20_000_000 }); } catch {}
  if (command === 'apply' && current !== original && current !== output && sha256(current ?? "") !== previousState.files?.[file]) throw new Error(`拒绝覆盖本地修改：${file}`);
  if (command === 'verify' && current !== output) throw new Error(`本地中文构建与词库不一致：${file}`);
}
// Preflight all files before writing: validation failures cannot leave a half overlay.
if (command === 'apply') {
  for (const [file, output] of changed) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), output); }
  fs.writeFileSync(statePath, JSON.stringify({ commit: lock.commit, files: Object.fromEntries([...changed].map(([f, text]) => [f, sha256(text)])) }, null, 2) + '\n');
}
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(reportDir, 'coverage.json'), JSON.stringify(report, null, 2) + '\n');
// 1.1.6：跟踪的根目录 source-contract.json 是唯一基线（本脚本读取它）；reports/ 不再写重复副本。
// 仅在上游升级、根基线被删除后才输出候选到 reports/ 供人工审阅再复制回根目录。
if (!Object.keys(known).length) fs.writeFileSync(path.join(reportDir, 'source-contract.json'), JSON.stringify(baseline, null, 2) + '\n');
fs.writeFileSync(path.join(reportDir, 'extracted.json'), JSON.stringify(Object.fromEntries(Object.entries(report.files).map(([f, r]) => [f, r.remaining])), null, 2) + '\n');
console.log(JSON.stringify({ command, changedFiles: changed.size, catalogEntries: report.catalogEntries, ...report.totals, reportDir }, null, 2));
