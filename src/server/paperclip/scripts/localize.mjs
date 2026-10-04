#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { extract, transform, translationFor, sha256 } from './localization-engine.mjs';
import { applyStructuralPatches } from './structural-patches.mjs';

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
const sourcePatches = fs.readdirSync(path.join(home, "catalogs")).filter(f => f.endsWith(".structural.json")).flatMap(f => JSON.parse(fs.readFileSync(path.join(home, "catalogs", f))));
const files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', 'ui/src'], { cwd: root, encoding: 'utf8' })
  .trim().split('\n').filter(file => /\.(?:tsx|ts)$/.test(file) && !/(?:\.test\.|\.fixtures?\.|UxLab|Perf|DesignGuide)/.test(file));
const report = { sourcePatchSites: sourcePatches.reduce((n, p) => n + (p.expected ?? 1), 0), upstream: lock, catalogEntries: Object.keys(catalog).length, scope: 'AST-identifiable static UI text; not all English in the source tree', files: {}, totals: { candidates: 0, translated: 0, remaining: 0, preserved: 0 }, structuralFiles: [] };
const changed = new Map();
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
  const result = transform(input, file, catalog, contexts[file] ?? {});
  if (!result.entries.length && result.output === source) continue;
  const preserved = result.entries.filter(e => translationFor(e, catalog, contexts[file] ?? {}) === e.text).map(({ text, line }) => ({ text, line }));
  const remaining = result.entries.filter(e => translationFor(e, catalog, contexts[file] ?? {}) === undefined).map(({ text, line }) => ({ text, line }));
  report.files[file] = { candidates: result.entries.length, translated: result.edits.length, preserved, remaining, sourcePatchSites: sourcePatches.filter(p => p.file === file).reduce((n, p) => n + (p.expected ?? 1), 0), sourceSha256: sha256(source) };
  report.totals.candidates += result.entries.length;
  report.totals.translated += result.edits.length;
  report.totals.remaining += remaining.length;
  report.totals.preserved += preserved.length;
  if (result.output !== source) changed.set(file, result.output);
  baseline[file] = sha256(source);
  if (known[file] && known[file] !== baseline[file]) throw new Error(`源文件指纹不匹配：${file}`);
}
applyStructuralPatches({ root, changed, report });
// When a catalogue or safety rule removes a previous translation, restore only
// our own hash-matching generated output. Never strand stale localized code.
for (const file of Object.keys(previousState.files ?? {})) {
  if (!changed.has(file)) {
    const original = execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 20_000_000 });
    changed.set(file, original);
  }
}
for (const [file, output] of changed) {
  const dest = path.join(root, file);
  const current = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;
  let original = null;
  try { original = execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 20_000_000 }); } catch {}
  if (command === 'apply' && current !== original && current !== output && sha256(current ?? "") !== previousState.files?.[file]) throw new Error(`拒绝覆盖本地修改：${file}`);
  if (command === 'verify' && current !== output) throw new Error(`本地中文构建与词库不一致：${file}`);
}
// Preflight all files before writing any file: failure cannot leave a half overlay.
if (command === 'apply') {
  for (const [file, output] of changed) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), output); }
  fs.writeFileSync(statePath, JSON.stringify({ commit: lock.commit, files: Object.fromEntries([...changed].map(([f, text]) => [f, sha256(text)])) }, null, 2) + '\n');
}
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(reportDir, 'coverage.json'), JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(path.join(reportDir, 'source-contract.json'), JSON.stringify(baseline, null, 2) + '\n');
fs.writeFileSync(path.join(reportDir, 'extracted.json'), JSON.stringify(Object.fromEntries(Object.entries(report.files).map(([f, r]) => [f, r.remaining])), null, 2) + '\n');
console.log(JSON.stringify({ command, changedFiles: changed.size, catalogEntries: report.catalogEntries, ...report.totals, reportDir }, null, 2));
