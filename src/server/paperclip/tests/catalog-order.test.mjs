// 1.1.6：结构补丁顺序由 catalogs/order.json 显式声明，不再依赖文件名字典序。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orderedStructuralCatalogs, loadStructuralPatches } from '../scripts/structural-patches.mjs';
import { source, original, applyPatches } from './helpers/patched.mjs';

function fixture(t, files, order) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-order-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of files) fs.writeFileSync(path.join(dir, file), '[]');
  if (order) fs.writeFileSync(path.join(dir, 'order.json'), JSON.stringify(order));
  return dir;
}

test('the repository order lists every structural catalog once and satisfies declared dependencies', () => {
  const order = orderedStructuralCatalogs();
  const present = fs.readdirSync(new URL('../catalogs', import.meta.url)).filter(f => f.endsWith('.structural.json'));
  assert.deepEqual([...order].sort(), present.sort());
  assert.ok(order.indexOf('zzzzz-round2-session.structural.json') > order.indexOf('zz-round1-data.structural.json'));
});

test('order follows the declared list even when it differs from lexical file names', t => {
  const dir = fixture(t, ['b.structural.json', 'a.structural.json'], { structural: ['b.structural.json', 'a.structural.json'], after: [{ catalog: 'a.structural.json', after: 'b.structural.json', reason: 'fixture dependency' }] });
  assert.deepEqual(orderedStructuralCatalogs(dir), ['b.structural.json', 'a.structural.json']);
});

test('missing order file, unlisted, stale, duplicate and conflicting entries fail', t => {
  assert.throws(() => orderedStructuralCatalogs(fixture(t, ['a.structural.json'])), /order\.json/);
  assert.throws(() => orderedStructuralCatalogs(fixture(t, ['a.structural.json', 'b.structural.json'], { structural: ['a.structural.json'] })), /未在 order\.json 登记.*b\.structural\.json/);
  assert.throws(() => orderedStructuralCatalogs(fixture(t, ['a.structural.json'], { structural: ['a.structural.json', 'gone.structural.json'] })), /不存在.*gone/);
  assert.throws(() => orderedStructuralCatalogs(fixture(t, ['a.structural.json'], { structural: ['a.structural.json', 'a.structural.json'] })), /重复登记/);
  assert.throws(() => orderedStructuralCatalogs(fixture(t, ['a.structural.json', 'b.structural.json'], { structural: ['a.structural.json', 'b.structural.json'], after: [{ catalog: 'a.structural.json', after: 'b.structural.json', reason: 'x' }] })), /顺序冲突/);
  assert.throws(() => orderedStructuralCatalogs(fixture(t, ['a.structural.json'], { structural: ['a.structural.json'], after: [{ catalog: 'a.structural.json', after: 'zz.structural.json', reason: 'x' }] })), /未登记/);
  assert.throws(() => orderedStructuralCatalogs(fixture(t, ['a.structural.json', 'b.structural.json'], { structural: ['b.structural.json', 'a.structural.json'], after: [{ catalog: 'a.structural.json', after: 'b.structural.json' }] })), /reason/);
});

test('the declared round1 → round2 dependency is real: the reverse order cannot apply', { skip: !source }, () => {
  const patches = loadStructuralPatches();
  const round1 = JSON.parse(fs.readFileSync(new URL('../catalogs/zz-round1-data.structural.json', import.meta.url)));
  const round2 = JSON.parse(fs.readFileSync(new URL('../catalogs/zzzzz-round2-session.structural.json', import.meta.url)));
  for (const file of ['ui/src/api/client.ts', 'ui/src/api/auth.ts']) {
    assert.ok(applyPatches(original(file), patches, file));
    assert.throws(() => applyPatches(applyPatches(original(file), round2, file), round1, file));
  }
});
