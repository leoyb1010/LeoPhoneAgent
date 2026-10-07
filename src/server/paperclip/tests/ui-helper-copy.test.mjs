// 1.1.7：lib/组件 helper 函数里的英文显示文案（非 JSX 位置，自动词库不覆盖）由 catalogs/ui-helper-copy.structural.json
// 按整行精确上下文改写。本测试回放规则（上下文唯一、可逆、插值不丢失、每条输出含中文），并对候选树做门禁扫描：
// ui/src 中新增的英文句子字面量必须进入规则或 catalogs/helper-copy-preserve.json 的逐条登记，否则失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { source, candidate, original, patched as patchedFile, readJson } from './helpers/patched.mjs';

const patches = JSON.parse(fs.readFileSync(new URL('../catalogs/ui-helper-copy.structural.json', import.meta.url)));
const preserve = JSON.parse(fs.readFileSync(new URL('../catalogs/helper-copy-preserve.json', import.meta.url)));
const files = [...new Set(patches.map(p => p.file))];
const CJK = /[\u3400-\u9fff]/;
const idents = text => [...new Set([...text.matchAll(/\$\{\s*([A-Za-z_][\w.]*)/g)].map(m => m[1]))];

test('helper-copy catalog is registered, every rule is a whole-line rewrite with Chinese output and intact interpolation', () => {
  assert.ok(readJson('catalogs/order.json').structural.includes('ui-helper-copy.structural.json'));
  assert.ok(patches.length > 900);
  for (const p of patches) {
    assert.match(p.file, /^ui\/src\/.+\.tsx?$/);
    assert.ok(p.from.startsWith('\n') && p.from.endsWith('\n') && p.to.startsWith('\n') && p.to.endsWith('\n'), `${p.file}: 整行上下文`);
    assert.ok(CJK.test(p.to), `${p.file}: ${p.to.trim().slice(0, 60)}`);
    const after = idents(p.to);
    for (const id of idents(p.from)) assert.ok(after.includes(id), `${p.file}: 插值 ${id} 丢失`);
    // 只改字符串字面量：去掉所有字符串后两行必须一致
    const strip = s => s.replace(/`(?:\\.|[^`])*`|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'/g, '""');
    assert.equal(strip(p.from), strip(p.to), `${p.file}: 只允许改字符串字面量`);
  }
  for (const entry of preserve) { assert.match(entry.file, /^ui\/src\//); assert.ok(entry.text && entry.reason); }
});

test('every helper-copy rule applies exactly once on the pinned source and reverses cleanly', { skip: !source }, () => {
  for (const file of files) assert.ok(patchedFile(file, patches, { reversible: true }));
});

const SENTENCE = /(["`])([A-Z][a-z]+(?: [a-z][a-z'’-]*){1,}[^"`\n]*?)\1/g;
const NOT_DISPLAY = /console\.|throw new|new Error\(|queryKey|data-testid|localStorage|sessionStorage|import |from "/;
function walk(dir, out = []) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (/\.tsx?$/.test(e.name)) out.push(p); } return out; }

test('candidate gate: no unregistered English sentence literal remains in ui/src helper code', { skip: !candidate }, () => {
  const allowed = new Set(preserve.map(e => `${e.file}\u0000${e.text}`));
  const offenders = [];
  for (const file of walk(path.join(candidate, 'ui/src'))) {
    const rel = path.relative(candidate, file);
    if (/\.test\.|fixtures?|DesignGuide|UxLab|Perf|stories|__tests__|smoke-board-fixture/.test(rel)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const s = line.trim();
      if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*') || CJK.test(line) || NOT_DISPLAY.test(line)) return;
      for (const m of line.matchAll(SENTENCE)) {
        const lit = m[0];
        if (new RegExp(`(===|!==)\\s*${lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(===|!==)`).test(line)) continue;
        if (!allowed.has(`${rel}\u0000${m[2]}`)) offenders.push(`${rel}:${i + 1}: ${m[2].slice(0, 70)}`);
      }
    });
  }
  assert.deepEqual(offenders, [], '新增的英文 helper 文案：请加入 ui-helper-copy 规则或 helper-copy-preserve.json');
});
