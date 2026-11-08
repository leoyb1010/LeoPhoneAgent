import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { inspectUI, checkTree } from '../scripts/check_ui_tokens.mjs';
assert.deepEqual(checkTree(), []);
for (const bad of ["SurfaceButton() { Text('x') }.width(44)", '@State width: number = 0;', "import { inputMethod } from '@kit.ImeKit';", 'Text(Copy.sectionLook)']) {
  assert.ok(inspectUI(bad, 'pages/Example.ets').length, 'compiler checkpoint regression must be caught');
}
for (const bad of ["Text('x').fontColor('#fff')", "Button('保存')", "Button({ type: ButtonType.Normal })", "Text('返回')"]) {
  assert.ok(inspectUI(bad, 'pages/Example.ets').length, bad);
}
assert.equal(inspectUI("Text('x').fontColor(Tokens.text)", 'pages/Example.ets').length, 0);
const source = fs.readFileSync(new URL('../app/entry/src/main/ets/theme/Tokens.ets', import.meta.url), 'utf8').replace('export class', 'class');
const Tokens = vm.runInNewContext(stripTypeScriptTypes(source) + '\nTokens');
for (const dark of [false, true, false]) {
  Tokens.apply(dark);
  assert.notEqual(Tokens.card, Tokens.grouped, 'grouped page must not swallow card edges');
  assert.notEqual(Tokens.text, Tokens.card);
  assert.notEqual(Tokens.accent, Tokens.sendGlyph);
  assert.ok(Tokens.avatarColors.length > 1);
}
console.log('UI_TOKENS_OK real token transitions + negative static gate fixtures');
// Run the actual release catalog rather than trusting only string matching.
const releaseSource = fs.readFileSync(new URL('../app/entry/src/main/ets/release/ReleaseCatalog.ets', import.meta.url), 'utf8').replace(/\bexport\s+/g, '');
const release = vm.runInNewContext(stripTypeScriptTypes(releaseSource) + '\nReleaseCatalog');
const notes = release.all();
assert.equal(release.currentVersion, '0.5.0'); assert.equal(release.currentBuild, 100029);
assert.equal(notes[0].version, release.currentVersion); assert.equal(notes[1].version, '0.4.0');
assert.equal(new Set(notes.map(row => row.version)).size, notes.length, 'release history must not duplicate a version');
const symbols = fs.readFileSync(new URL('../app/entry/src/main/ets/theme/Symbols.ets', import.meta.url),'utf8');
const names = new Set([...symbols.matchAll(/\$r\('sys\.symbol\.([^']+)'\)/g)].map(m=>m[1]));
const mappings = symbols.slice(symbols.indexOf('export class SettingsSymbols'));
for (const match of mappings.matchAll(/:\s*'([^']+)'/g)) assert.ok(names.has(match[1]), `missing semantic glyph: ${match[1]}`);
console.log('RELEASE_AND_SYMBOL_MAPPING_OK actual catalog + declared whitelist (SDK resource existence not proven)');
