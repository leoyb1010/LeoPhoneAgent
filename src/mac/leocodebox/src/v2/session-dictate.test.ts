import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { appendDictate, canDictate, clipDictateText, dictateToast, speechRecognitionCtor } from './session-dictate';

test('本机才能对着说，听到的字接到草稿后面', () => {
  assert.equal(canDictate('local'), true);
  assert.equal(canDictate('fold'), false);
  assert.equal(canDictate(''), false);
  assert.equal(clipDictateText('  改 ART31.txt  \n'), '改 ART31.txt');
  assert.equal(appendDictate('先看', '别改别的'), '先看 别改别的');
  assert.equal(appendDictate('  ', '写一个文件'), '写一个文件');
  assert.equal(speechRecognitionCtor(), null);
  assert.match(dictateToast('改 ART31.txt'), /已听写/);
  assert.match(dictateToast('   '), /没听清/);
});

test('2.0 壳接上了对着说，不进输入栏', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /canDictate/);
  assert.match(app, /对着说/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /对着说/);
});
