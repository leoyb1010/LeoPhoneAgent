import test from 'node:test';
import assert from 'node:assert/strict';

import { createPendingPromptSlot, decidePendingPromptSend } from './pendingPrompt';

test('首句只能被消费一次 —— 第二次读到 null,不会重发', () => {
  const slot = createPendingPromptSlot();
  slot.set('把 README 翻成英文');
  assert.equal(slot.consume(), '把 README 翻成英文');
  assert.equal(slot.consume(), null);
});

test('消费之后 slot 归零,peek 也看不到了', () => {
  const slot = createPendingPromptSlot();
  slot.set('跑一遍测试');
  assert.equal(slot.peek(), '跑一遍测试');
  slot.consume();
  assert.equal(slot.peek(), null);
});

test('空草稿不入库 —— 指挥条留空回车不该留下待发状态', () => {
  const slot = createPendingPromptSlot();
  slot.set('   ');
  assert.equal(slot.peek(), null);
  slot.set('');
  assert.equal(slot.peek(), null);
  slot.set(undefined);
  assert.equal(slot.peek(), null);
});

test('不带首句开新会话会清掉上一条待发的,避免串到下一个会话', () => {
  const slot = createPendingPromptSlot();
  slot.set('第一句');
  slot.set(null);
  assert.equal(slot.consume(), null);
});

const base = {
  pendingPrompt: '把 README 翻成英文' as string | null,
  selectedSessionId: null as string | null,
  currentSessionId: null as string | null,
  hasProject: true,
};

test('没有待发首句就什么都不做', () => {
  assert.equal(decidePendingPromptSend({ ...base, pendingPrompt: null }), 'wait');
});

test('reset 未完成时不发 —— 这就是消息被打进旧会话的那一刻', () => {
  // handleNewSession 的 setState 还没生效,selectedSession 仍指向刚才那个会话。
  assert.equal(decidePendingPromptSend({ ...base, selectedSessionId: 'old-session' }), 'wait');
  // 父层清空了,但会话内的 currentSessionId 还没被 newSessionTrigger reset 清掉。
  assert.equal(decidePendingPromptSend({ ...base, currentSessionId: 'old-session' }), 'wait');
});

test('没有项目时先等着,别把这句话丢了', () => {
  assert.equal(decidePendingPromptSend({ ...base, hasProject: false }), 'wait');
});

test('空首句直接作废,不发空消息', () => {
  assert.equal(decidePendingPromptSend({ ...base, pendingPrompt: '   ' }), 'drop');
  assert.equal(decidePendingPromptSend({ ...base, pendingPrompt: '' }), 'drop');
});

test('两个 id 都归零之后才发,这时 handleSubmit 会去申请新会话', () => {
  assert.equal(decidePendingPromptSend(base), 'send');
});
