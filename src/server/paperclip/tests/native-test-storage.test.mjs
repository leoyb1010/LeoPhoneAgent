import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
const source = process.env.PAPERCLIP_SOURCE;
const candidate = process.env.PAPERCLIP_CANDIDATE;
const patch = JSON.parse(fs.readFileSync(new URL('../catalogs/native-test-storage.source-patch.json', import.meta.url)));
function original() { return execFileSync('git', ['show', `HEAD:${patch.file}`], { cwd: source, encoding: 'utf8' }); }
function localized() {
  const text = original();
  assert.equal(crypto.createHash('sha256').update(text).digest('hex'), patch.sourceSha256);
  assert.equal(text.split(patch.from).length - 1, patch.expected);
  return text.replace(patch.from, patch.to);
}
function runner(text, env, platform, parent) {
  const ast = ts.createSourceFile(patch.file, text, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'runVitest');
  assert.ok(fn);
  const spawns = [];
  const made = [];
  const fakeProcess = { env, platform, pid: 1234, exit: code => { throw new Error(`exit ${code}`); } };
  const run = new Function('process', 'os', 'path', 'realpathSync', 'mkdtempSync', 'mkdirSync', 'spawnSync', 'console', `let invocationIndex=0;const sourceOnlyVitestArgs=[];const repoRoot="fixture-checkout";${fn.getText(ast)};return runVitest;`)(
    fakeProcess, { tmpdir: () => parent }, path, fs.realpathSync, prefix => { const dir = fs.mkdtempSync(prefix); made.push(dir); return dir; }, fs.mkdirSync,
    (...args) => { spawns.push(args); return { status: 0 }; }, { log() {}, error() {} });
  try { run(['--project', 'fixture'], 'isolated storage check'); return spawns[0]; }
  finally { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); }
}
function check(text) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-storage-'));
  try {
    const realParent = path.join(base, 'external'); fs.mkdirSync(realParent);
    const alias = path.join(base, 'alias'); fs.symlinkSync(realParent, alias, 'dir');
    const inputEnv = { HOME: '/preserved-home', HTTPS_PROXY: 'http://127.0.0.1:7890', PAPERCLIP_TEST_TMPDIR: alias };
    const [command, args, options] = runner(text, inputEnv, 'darwin', realParent);
    assert.equal(command, 'pnpm'); assert.deepEqual(args, ['exec', 'vitest', 'run', '--project', 'fixture']);
    const env = options.env;
    const testRoot = path.dirname(env.PAPERCLIP_HOME);
    assert.equal(path.dirname(testRoot), fs.realpathSync(realParent), 'fixtures are canonical and on the override volume');
    assert.match(path.basename(testRoot), /^pv-[\w-]{6}$/);
    assert.equal(env.PAPERCLIP_HOME, path.join(testRoot, 'h'));
    assert.equal(env.TMPDIR, path.join(testRoot, 't'));
    assert.equal(env.PAPERCLIP_CONFIG, path.join(testRoot, 'h', 'config.json'));
    assert.equal(env.HOME, inputEnv.HOME); assert.equal(env.HTTPS_PROXY, inputEnv.HTTPS_PROXY);
    assert.equal(env.PAPERCLIP_INSTANCE_ID, 'vt-1234-1');
    assert.throws(() => runner(text, { PAPERCLIP_TEST_TMPDIR: path.join(base, 'missing') }, 'darwin', realParent), /ENOENT/, 'missing override parent never falls back to internal temporary storage');
    for (const platform of ['darwin', 'win32']) for (const override of [undefined, '']) {
      const environment = override === undefined ? {} : { PAPERCLIP_TEST_TMPDIR: override };
      const normalize = ([command, args, options]) => {
        const root = path.dirname(options.env.PAPERCLIP_HOME);
        assert.equal(path.dirname(root), fs.realpathSync(platform === 'win32' ? realParent : '/tmp'));
        return [command, args, { ...options, env: Object.fromEntries(Object.entries(options.env).map(([key, value]) => [key, typeof value === 'string' ? value.replace(root, '<fixture-root>') : value])) }];
      };
      assert.deepEqual(normalize(runner(text, environment, platform, realParent)), normalize(runner(original(), environment, platform, realParent)), 'default behavior is unchanged apart from random fixture names');
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
}
test('stable Vitest runner supports external test storage with canonical compact fixture paths', { skip: !source }, () => {
  const text = localized();
  assert.equal(text.replace(patch.to, patch.from), original(), 'only the reviewed temp-parent line changes');
  execFileSync(process.execPath, ['--check', '--input-type=module'], { input: text });
  check(text);
});
test('generated test runner has the exact reviewed external temp-directory override', { skip: !source || !candidate }, () => {
  assert.equal(fs.readFileSync(path.join(candidate, patch.file), 'utf8'), localized());
});
