import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AskUserQuestionPanel } from './AskUserQuestionPanel';

function render(input: unknown) {
  return renderToStaticMarkup(
    React.createElement(AskUserQuestionPanel, {
      request: {
        requestId: 'req-1',
        toolName: 'AskUserQuestion',
        input,
      } as never,
      onDecision: () => undefined,
    }),
  );
}

// Live permission prompt is inside the chat ErrorBoundary. A streaming
// AskUserQuestion payload without `options` used to throw
// "Cannot read properties of undefined (reading 'length')" and blank
// the whole pane with "此区域暂时无法加载".

test('renders without throwing when questions is missing or not an array', () => {
  assert.doesNotThrow(() => render(undefined));
  assert.doesNotThrow(() => render({ questions: { 0: { question: 'q?' } } }));
  assert.equal(render({ questions: { 0: { question: 'q?' } } }), '');
});

test('renders without throwing when a question is missing options[]', () => {
  assert.doesNotThrow(() => {
    const html = render({ questions: [{ question: 'Pick one?', header: 'H' }] });
    assert.ok(html.includes('Pick one?'));
  });
});

test('renders without throwing when options[] contains malformed entries', () => {
  assert.doesNotThrow(() => {
    const html = render({
      questions: [{ question: 'Pick one?', options: [null, 'oops', { label: 'A' }] }],
    });
    assert.ok(html.includes('Pick one?'));
    assert.ok(html.includes('A'));
  });
});

test('still renders a well-formed question', () => {
  const html = render({
    questions: [{ question: 'Pick one?', header: 'H', options: [{ label: 'A' }, { label: 'B' }] }],
  });
  assert.ok(html.includes('Pick one?'));
  assert.ok(html.includes('A'));
  assert.ok(html.includes('B'));
});
