import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canRetractFollowUp, retractLastFollowUp } from './session-queue-retract';

test('排队的上一句能拿回来', () => {
  const queued = [
    { key: '1', text: '先改类型' },
    { key: '2', text: '再补测试' },
  ];
  assert.deepEqual(retractLastFollowUp(queued), {
    text: '再补测试',
    rest: [{ key: '1', text: '先改类型' }],
  });
  assert.deepEqual(retractLastFollowUp([{ key: '1', text: '只这一句' }]), {
    text: '只这一句',
    rest: [],
  });
  assert.equal(retractLastFollowUp([]), null);
  assert.equal(retractLastFollowUp([{ key: '1', text: '   ' }]), null);
  const looking = { machine: 'local', draft: '', queued };
  assert.equal(canRetractFollowUp(looking), true);
  assert.equal(canRetractFollowUp({ ...looking, draft: '还在打' }), false);
  assert.equal(canRetractFollowUp({ ...looking, queued: [] }), false);
  assert.equal(canRetractFollowUp({ ...looking, machine: 'phone' }), false);
});

test('2.0 收回排队不进输入栏按钮', () => {
  const app = readFileSync(fileURLToPath(new URL('./App2.tsx', import.meta.url)), 'utf8');
  assert.match(app, /canRetractFollowUp/);
  assert.match(app, /retractLastFollowUp/);
  assert.match(app, /Backspace/);
  const acts = app.match(/className="composer-acts"[\s\S]{0,800}/)?.[0] ?? '';
  assert.doesNotMatch(acts, /拿回来|canRetractFollowUp|retractLastFollowUp/);
});
