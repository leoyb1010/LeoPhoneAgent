import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  applyFileMention,
  canCompleteFileMention,
  fileMentionToken,
  matchMentionFiles,
  mentionableSessionFiles,
} from './session-mention-file';

test('输入栏 @ 再按 Tab 能带上文件', () => {
  assert.deepEqual(mentionableSessionFiles(['src/a.ts', 'src/a.ts', '', 'src/b.ts']), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(fileMentionToken('看 @App', 6), { start: 2, query: 'App' });
  assert.equal(fileMentionToken('mail@x.com', 10), null);
  assert.equal(fileMentionToken('看 @App 后面', 10), null);
  assert.deepEqual(
    matchMentionFiles(['src/v2/App2.tsx', 'src/mac/leocodebox.ts'], 'App'),
    ['src/v2/App2.tsx'],
  );
  assert.equal(applyFileMention('看 @App', { start: 2 }, 'src/v2/App2.tsx', 6), '看 src/v2/App2.tsx');
  const looking = {
    machine: 'local',
    prompt: '改 @App',
    cursor: 5,
    files: ['src/v2/App2.tsx', 'README.md'],
  };
  assert.equal(canCompleteFileMention(looking), true);
  assert.equal(canCompleteFileMention({ ...looking, machine: 'phone' }), false);
  assert.equal(canCompleteFileMention({ ...looking, prompt: '改这里' }), false);
  assert.equal(canCompleteFileMention({ ...looking, files: [] }), false);
});

test('2.0 @ 带文件不进输入栏按钮', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /canCompleteFileMention/);
  assert.match(app, /applyFileMention/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /带上文件|canCompleteFileMention|applyFileMention/);
});
