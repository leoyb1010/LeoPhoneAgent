#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const home = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = JSON.parse(fs.readFileSync(process.argv[2] || path.join(home, 'reports/coverage.json')));
const contract = JSON.parse(fs.readFileSync(path.join(home, 'coverage-contract.json')));
assert.equal(report.upstream.commit, contract.commit, 'wrong upstream SHA');
if (contract.maximumUnreviewedStaticRemaining !== undefined) assert.ok(report.totals.remaining <= contract.maximumUnreviewedStaticRemaining, `全站仍有 ${report.totals.remaining} 处未经审阅的静态英文`);
const dynamicPreserve = JSON.parse(fs.readFileSync(path.join(home, 'catalogs/dynamic-preserve.json')));
for (const entry of dynamicPreserve) assert.ok(entry.file && entry.text && entry.reason && entry.category, 'unexplained dynamic exception');
const approvedDynamic = new Set(dynamicPreserve.map(e => `${e.file}\0${e.text}`));
const actualDynamic = Object.entries(report.files).flatMap(([file, r]) => (r.dynamicRemaining ?? []).map(e => `${file}\0${e.text}`));
assert.deepEqual(actualDynamic.filter(key => !approvedDynamic.has(key)), [], 'unreviewed dynamic English remains');
assert.deepEqual([...approvedDynamic].filter(key => !actualDynamic.includes(key)), [], 'stale dynamic exception; review before updating');
const rows = [];
for (const [name, group] of Object.entries(contract.groups)) {
  const matching = Object.entries(report.files).filter(([f]) => new RegExp(group.pattern).test(f));
  assert.ok(matching.length >= group.minimumFiles, `${name}: missing files`);
  const candidates = matching.reduce((s, [, r]) => s + r.candidates, 0);
  const translated = matching.reduce((s, [, r]) => s + r.translated, 0);
  const remaining = matching.reduce((s, [, r]) => s + r.remaining.length, 0);
  assert.ok(group.minimumTranslated === undefined || translated >= group.minimumTranslated, `${name}: translated count regressed (${translated} < ${group.minimumTranslated})`);
  const approved = new Set(group.allowedRemaining.map(e => `${e.file}\0${e.text}`));
  const unexpected = matching.flatMap(([file, r]) => r.remaining.filter(e => !approved.has(`${file}\0${e.text}`)).map(e => `${file}:${e.line} ${e.text}`));
  assert.deepEqual(unexpected, [], `${name}: unreviewed English remains`);
  rows.push({ name, files: matching.length, candidates, translated, remaining });
}
console.log(JSON.stringify({ passed: true, groups: rows, fullTree: report.totals }, null, 2));
