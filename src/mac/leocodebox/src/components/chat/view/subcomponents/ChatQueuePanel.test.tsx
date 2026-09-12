import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import ChatQueuePanel from './ChatQueuePanel';

const recovered = {
  id: 'recover-1', sessionId: 'session-a', clientRequestId: 'request-1', content: 'Review the previous result',
  state: 'needs_confirmation' as const, createdAt: 1, reason: 'server_restarted_during_run', attachmentCount: 0,
};

test('interrupted queue displays the partial-execution warning and needs a deliberate resume click', async () => {
  const resumed: string[] = [];
  const cancelled: string[] = [];
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => { renderer = TestRenderer.create(<ChatQueuePanel items={[recovered]} error="" pendingActionIds={new Set()}
      onResume={(id) => resumed.push(id)} onCancel={(id) => cancelled.push(id)} />); });
    assert.deepEqual(resumed, []);
    assert.match(JSON.stringify(renderer.toJSON()), /可能已执行部分步骤/);
    const buttons = renderer.root.findAllByType('button');
    act(() => buttons[0].props.onClick());
    assert.deepEqual(resumed, ['recover-1']);
    act(() => buttons[1].props.onClick());
    assert.deepEqual(cancelled, ['recover-1']);
  } finally { await act(async () => renderer.unmount()); }
});
