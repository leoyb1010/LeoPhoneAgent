import assert from 'node:assert/strict';
import test from 'node:test';

import React, { useRef, useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { useQueuedChatDraft } from './useQueuedChatDraft';

test('a legacy local queued draft never auto-runs when the prior task becomes idle', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map([['queued_message_session-a', JSON.stringify({ content: 'legacy draft' })]]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  const sends: unknown[] = [];
  function Harness({ loading }: { loading: boolean }) {
    const [, setInput] = useState('');
    const [, setImages] = useState<File[]>([]);
    const inputValueRef = useRef('');
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const handleSubmitRef = useRef(async () => { sends.push('sent'); });
    const args = { sessionKey: 'session-a', isLoading: loading, setInput, inputValueRef,
      setAttachedImages: setImages, textareaRef, handleSubmitRef };
    const { queuedDraft } = useQueuedChatDraft(args);
    return <output>{queuedDraft?.content}</output>;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => { renderer = TestRenderer.create(<Harness loading />); });
    await act(async () => { renderer.update(<Harness loading={false} />); await new Promise((resolve) => setTimeout(resolve, 25)); });
    assert.deepEqual(sends, []);
    assert.equal(renderer.root.findByType('output').children.join(''), 'legacy draft');
  } finally {
    await act(async () => renderer.unmount());
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});
