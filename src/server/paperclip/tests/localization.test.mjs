import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { extract, transform, sha256 } from '../scripts/localization-engine.mjs';
const catalog = { Pending: '待处理', pending: '待处理', Name: '名称', 'Save &amp; exit': '保存并退出', 'Failed to save': '保存失败' };

test('only display nodes change; identifiers, comparisons, routes and user data survive', () => {
  const input = `import { Pending } from "Pending";
const status = "pending"; const key = ["Pending"]; const data = { value: "Pending", status: "pending", body: "Name" };
function Form({user}) { return <><p>{user.name}</p><p>Pending</p><input name="Name" placeholder="Name" value={user.name}/><button onClick={()=>api.post("/Pending", {status:"pending"})}>{status === "pending" ? "Pending" : user.title}</button><code>Pending</code><pre>{"Pending"}</pre><p>Save &amp; exit</p></> }`;
  const { output } = transform(input, 'Form.tsx', catalog);
  for (const exact of ['from "Pending"', 'const status = "pending"', 'const key = ["Pending"]', 'value: "Pending"', 'status: "pending"', 'body: "Name"', 'name="Name"', 'value={user.name}', 'api.post("/Pending", {status:"pending"})', 'status === "pending"', '<code>Pending</code>', '<pre>{"Pending"}</pre>', '{user.name}']) assert.ok(output.includes(exact), exact);
  assert.ok(output.includes('placeholder="名称"'));
  assert.ok(output.includes('{"待处理"}'));
  assert.ok(output.includes('"保存并退出"'));
});

test('per-file/per-line context overrides do not leak into other display locations', () => {
  const input = '<><p>Name</p>\n<p>Name</p></>';
  const { output } = transform(input, 'a.tsx', catalog, { '1:Name': '姓名' });
  assert.ok(output.includes('"姓名"')); assert.ok(output.includes('"名称"'));
});

test('source transformation is idempotent and JSX translations are literal, never executable', () => {
  const first = transform('<p>Name</p>', 'A.tsx', { Name: '{globalThis.BAD = true} <script> & < >' }).output;
  assert.ok(first.includes('"{globalThis.BAD = true} <script> & < >"'));
  assert.equal(transform(first, 'A.tsx', catalog).output, first);
  assert.equal(extract(first, 'A.tsx').length, 1);
});

test('dynamic templates and arbitrary calls are not automatically rewritten', () => {
  const input = 'const x = "Name"; <div title={`Name ${user.name}`}>{format("Name")}{obj.status === "Pending" && user.body}</div>';
  assert.equal(transform(input, 'A.tsx', catalog).output, input);
});

test('toast body is translated but API body is not', () => {
  const input = 'pushToast({title:"Name",body:"Failed to save"}); api.post("/x",{body:"Failed to save"});';
  const out = transform(input, 'A.tsx', catalog).output;
  assert.ok(out.includes('body:"保存失败"'));
  assert.ok(out.includes('api.post("/x",{body:"Failed to save"})'));
});

test('source fingerprint is deterministic and changes with input', () => {
  assert.equal(sha256('Name'), sha256('Name')); assert.notEqual(sha256('Name'), sha256('名称'));
});

const helperSource = fs.readFileSync(new URL('../overlays/zh-CN.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(helperSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }}).outputText;
const helpers = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
test('display mapping retains original protocol values and unknown identifiers', () => {
  assert.equal(helpers.displayStatus('in_progress'), '进行中');
  assert.equal(helpers.displayStatus('external_custom_state'), 'external_custom_state');
});
test('localized errors preserve raw diagnostics and map status/code separately', () => {
  const error = Object.assign(new Error('Sensitive upstream detail stays unchanged'), { status: 403 });
  assert.match(helpers.userErrorMessage(error), /权限/);
  assert.equal(helpers.rawDiagnostic(error), 'Sensitive upstream detail stays unchanged');
  assert.equal(error.message, 'Sensitive upstream detail stays unchanged');
  assert.match(helpers.userErrorMessage({code:'INVALID_EMAIL_OR_PASSWORD',message:'raw'}), /邮箱或密码/);
  assert.match(helpers.userErrorMessage(new Error('Failed to fetch')), /网络/);
});

test('catalogs have consistent duplicates and translated strings cannot add executable markup', () => {
  const seen = new Map();
  for (const file of fs.readdirSync(new URL('../catalogs', import.meta.url)).filter(f => f.endsWith('.zh-CN.json'))) {
    const values = JSON.parse(fs.readFileSync(new URL('../catalogs/' + file, import.meta.url)));
    for (const [en, zh] of Object.entries(values)) {
      assert.equal(typeof zh, 'string'); assert.ok(zh.trim(), `${file}: ${en}`);
      if (seen.has(en)) assert.equal(zh, seen.get(en), `duplicate: ${en}`);
      seen.set(en, zh);
      assert.ok(!/<script|javascript:|onerror=/i.test(zh), en);
    }
  }
});
