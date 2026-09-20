import assert from 'node:assert/strict';
import test from 'node:test';

import { EVENT_TOOL_COMPLETED, PiRpcDialect } from './harness-dialects.js';
import { sessionToolImages } from './session-tool-image.js';

test('工具结果里的图会抽出来', () => {
  const images = sessionToolImages({
    content: [
      { type: 'text', text: 'Read image file [image/png]' },
      { type: 'image', mimeType: 'image/png', data: 'AAAABBBB' },
    ],
  });
  assert.equal(images.length, 1);
  assert.equal(images[0]?.mimeType, 'image/png');
  assert.equal(images[0]?.data, 'AAAABBBB');
  assert.deepEqual(sessionToolImages({ content: [{ type: 'text', text: 'ok' }] }), []);
});

test('read 结束时图会进 tool.completed', () => {
  const dialect = new PiRpcDialect();
  const { events } = dialect.translateLine({
    type: 'tool_execution_end',
    toolCallId: 'r1',
    toolName: 'read',
    isError: false,
    result: {
      content: [
        { type: 'text', text: 'Read image file [image/png]' },
        { type: 'image', mimeType: 'image/png', data: 'AAAABBBB' },
      ],
    },
  });
  assert.equal(events[0]?.event, EVENT_TOOL_COMPLETED);
  assert.deepEqual(events[0]?.images, [{ mimeType: 'image/png', data: 'AAAABBBB' }]);
  assert.equal(events[0]?.output, 'Read image file [image/png]');
});
