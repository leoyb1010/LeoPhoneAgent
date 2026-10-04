#!/usr/bin/env node
// Deployment overlay only: rebuilding the upstream server requires reapplying it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const [command, rootArg, ...extra] = process.argv.slice(2);
assert.ok(['apply', 'verify'].includes(command) && rootArg && !extra.length,
  'Usage: node apply-native-avatar-runtime.mjs <apply|verify> <physical pinned source root>');
const commit = '994d6edcdd4e15d5f9cc5cf8c135ac599104b86a';
const before = 'd7d0af069d84eaba361724374da9873a06d41bdd9f917eeec83334b1c83d2454';
const after = 'a2f535539e9f81e4e459c432421b7134c85bf1c210d229493e6ee9a812808b8f';
const from = 'import { renderAgentSvg } from "@paperclipai/shared/cliplab/static";';
const to = 'import { renderAgentSvg } from "../../../packages/shared/dist/cliplab/static.js";';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const root = path.resolve(rootArg);
assert.equal(fs.realpathSync(root), root, 'root and ancestors must not be symlinks');
assert.equal(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim(), root, 'root must be the upstream checkout');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), commit, 'unknown upstream commit');

function regularFile(relative) {
  const file = path.join(root, relative);
  assert.equal(fs.realpathSync(file), file, `refuse symlink: ${relative}`);
  assert.ok(fs.lstatSync(file).isFile(), `regular file required: ${relative}`);
  return file;
}
for (const [relative, expected] of Object.entries({
  'server/src/services/agent-avatar-worker.ts': 'd0175f617d66ff4b6cf720e4cb04e618cc7e16822b3addd1762ebd8dfca164d9',
  'server/src/services/agent-avatar-pool.ts': 'f389da80f0e17f1b00f9fc017fc37059db430a80d21163fe0fa589aacae7e9c8',
  'packages/shared/src/cliplab/static.ts': 'acdfa69ecedc24fed36607503ac41f6e72a33a5ce7a5f8fff0abfef3a89121c7',
  'packages/shared/package.json': '38df4d0130267dc463dc0303e6140653892e3ce130a109a737a209361ebb6435',
})) {
  assert.equal(hash(fs.readFileSync(regularFile(relative))), expected, `unknown source: ${relative}`);
  assert.equal(hash(execFileSync('git', ['show', `${commit}:${relative}`], { cwd: root })), expected, `unknown committed source: ${relative}`);
}
for (const relative of ['packages/shared/dist/cliplab/static.js', 'packages/shared/dist/cliplab/definition.js']) {
  assert.ok(fs.statSync(regularFile(relative)).size > 0, `missing built shared module: ${relative}`);
}
const file = regularFile('server/dist/services/agent-avatar-worker.js');
const current = fs.readFileSync(file);
const fingerprint = hash(current);
assert.ok([before, after].includes(fingerprint), 'unknown compiled worker; refuse overwrite');
if (command === 'verify') assert.equal(fingerprint, after, 'avatar runtime overlay not applied');
if (command === 'apply' && fingerprint === before) {
  const source = current.toString('utf8');
  assert.equal(source.split(from).length - 1, 1, 'expected exactly one reviewed import');
  const output = Buffer.from(source.replace(from, to));
  assert.equal(hash(output), after, 'unexpected replacement output');
  execFileSync(process.execPath, ['--check', '--input-type=module'], { input: output });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', fs.statSync(file).mode & 0o777);
    try { fs.writeFileSync(fd, output); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    regularFile('server/dist/services/agent-avatar-worker.js');
    assert.equal(hash(fs.readFileSync(file)), before, 'worker changed during apply');
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
assert.equal(hash(fs.readFileSync(file)), after, 'final compiled worker fingerprint');
console.log(JSON.stringify({ command, root, commit, sha256: after, changed: command === 'apply' && fingerprint === before }));
