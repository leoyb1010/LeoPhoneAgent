#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const [command, rootArg] = process.argv.slice(2);
if (!['apply', 'verify'].includes(command) || !rootArg) throw new Error('Usage: node apply-test-storage.mjs <apply|verify> <pinned Paperclip source>');
const root = fs.realpathSync(rootArg);
const lock = JSON.parse(fs.readFileSync(new URL('../upstream.lock.json', import.meta.url)));
const patch = JSON.parse(fs.readFileSync(new URL('../catalogs/native-test-storage.source-patch.json', import.meta.url)));
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
assert.equal(patch.file, 'scripts/run-vitest-stable.mjs');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), lock.commit, 'pinned upstream commit');
const original = execFileSync('git', ['show', `HEAD:${patch.file}`], { cwd: root, encoding: 'utf8' });
assert.equal(hash(original), patch.sourceSha256, 'pinned test runner source fingerprint');
assert.equal(original.split(patch.from).length - 1, patch.expected, 'exact reviewed patch context');
const output = original.replace(patch.from, patch.to);
const target = path.join(root, patch.file);
assert.ok(!fs.lstatSync(target).isSymbolicLink(), 'test runner must not be a symlink');
const current = fs.readFileSync(target, 'utf8');
assert.ok(current === original || current === output, 'refuse to overwrite local test-runner edits');
execFileSync(process.execPath, ['--check', '--input-type=module'], { input: output, stdio: ['pipe', 'pipe', 'pipe'] });
const statePath = path.join(root, '.leophone-test-storage-overlay.json');
const state = { commit: lock.commit, file: patch.file, sha256: hash(output) };
if (fs.existsSync(statePath)) assert.deepEqual(JSON.parse(fs.readFileSync(statePath)), state, 'separate test-storage overlay state');
if (command === 'verify') {
  assert.equal(current, output, 'test-storage overlay not applied');
  assert.ok(fs.existsSync(statePath), 'test-storage state is required');
} else {
  if (current !== output) fs.writeFileSync(target, output);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}
console.log(JSON.stringify({ command, root, ...state }, null, 2));
