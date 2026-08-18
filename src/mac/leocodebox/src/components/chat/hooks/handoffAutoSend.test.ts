import test from 'node:test';
import assert from 'node:assert/strict';

import { decideHandoffAutoSend } from './handoffAutoSend';

const base = {
  armed: true,
  selectedSessionId: null as string | null,
  currentSessionId: null as string | null,
  draft: '把 README 翻成英文',
};

test('没挂号就什么都不做', () => {
  assert.equal(decideHandoffAutoSend({ ...base, armed: false }), 'wait');
});

test('还挂在上一个会话上时必须等 —— 这就是消息被打进旧会话的那一刻', () => {
  // 指挥条回车的同一拍:handleNewSession 的 setState 还没生效,
  // selectedSession 仍指向刚才那个会话。
  assert.equal(decideHandoffAutoSend({ ...base, selectedSessionId: 'old-session' }), 'wait');
  // 父层清空了,但会话内的 currentSessionId 还没被 newSessionTrigger reset 清掉。
  assert.equal(decideHandoffAutoSend({ ...base, currentSessionId: 'old-session' }), 'wait');
});

test('两个 id 都归零之后才发,这时 handleSubmit 会去申请新会话', () => {
  assert.equal(decideHandoffAutoSend(base), 'send');
});

test('草稿被清空则作废,不发空消息', () => {
  assert.equal(decideHandoffAutoSend({ ...base, draft: '   ' }), 'drop');
  assert.equal(decideHandoffAutoSend({ ...base, draft: '' }), 'drop');
});
