import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { useTaskDraft } from './useTaskDraft';

function harness(send: (prompt: string) => boolean | Promise<boolean>) {
  let state!: ReturnType<typeof useTaskDraft>;
  function Probe() { state = useTaskDraft(send); return <span />; }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(<Probe />); });
  return { state: () => state, close: () => act(() => renderer.unmount()) };
}

test('one submit is in flight even when Enter repeats before a render', async () => {
  let finish!: (ok: boolean) => void;
  const calls: string[] = [];
  const probe = harness(async (prompt) => { calls.push(prompt); return new Promise((resolve) => { finish = resolve; }); });
  try {
    act(() => probe.state().setDraft('Run once'));
    act(() => { void probe.state().submit(); void probe.state().submit(); });
    assert.deepEqual(calls, ['Run once']);
    await act(async () => finish(true));
    assert.equal(probe.state().draft, '');
    assert.equal(probe.state().busy, false);
  } finally { probe.close(); }
});

test('a declined or failed submission preserves the draft and exposes the error', async () => {
  let fail = false;
  const probe = harness(() => { if (fail) throw new Error('Offline'); return false; });
  try {
    act(() => probe.state().setDraft('Keep this'));
    await act(async () => { await probe.state().submit(); });
    assert.equal(probe.state().draft, 'Keep this');
    fail = true;
    await act(async () => { await probe.state().submit(); });
    assert.equal(probe.state().draft, 'Keep this');
    assert.equal(probe.state().error, 'Offline');
  } finally { probe.close(); }
});

test('finishing the previous request does not erase text edited during submission', async () => {
  let finish!: (ok: boolean) => void;
  const probe = harness(() => new Promise((resolve) => { finish = resolve; }));
  try {
    act(() => probe.state().setDraft('Original'));
    act(() => { void probe.state().submit(); });
    act(() => probe.state().setDraft('Next draft'));
    await act(async () => finish(true));
    assert.equal(probe.state().draft, 'Next draft');
  } finally { probe.close(); }
});
