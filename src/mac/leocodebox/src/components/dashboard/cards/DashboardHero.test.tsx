import test from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import DashboardHeaderActions from './DashboardHeaderActions';

function findButton(renderer: TestRenderer.ReactTestRenderer, ariaLabel: string) {
  return renderer.root.findAllByType('button').find((button) => button.props['aria-label'] === ariaLabel);
}

test('dashboard control settings button invokes its required handler', () => {
  let settingsCalls = 0;
  let renderer!: TestRenderer.ReactTestRenderer;

  act(() => {
    renderer = TestRenderer.create(
      <DashboardHeaderActions
        onShowSettings={() => { settingsCalls += 1; }}
        onRefresh={async () => ({ ok: true })}
      />,
    );
  });

  const button = findButton(renderer, '打开控制设置');
  assert.ok(button, 'settings control must remain visible and accessible');
  act(() => button.props.onClick());
  assert.equal(settingsCalls, 1);
  act(() => renderer.unmount());
});

test('dashboard refresh reports progress, blocks duplicate requests, and confirms success', async () => {
  let refreshCalls = 0;
  let finishRefresh!: (value: { ok: boolean }) => void;
  let renderer!: TestRenderer.ReactTestRenderer;

  const onRefresh = () => {
    refreshCalls += 1;
    return new Promise<{ ok: boolean }>((resolve) => {
      finishRefresh = resolve;
    });
  };

  act(() => {
    renderer = TestRenderer.create(
      <DashboardHeaderActions onShowSettings={() => undefined} onRefresh={onRefresh} />,
    );
  });

  const idleButton = findButton(renderer, '刷新状态');
  assert.ok(idleButton, 'refresh control must remain visible and accessible');
  act(() => idleButton.props.onClick());

  const loadingButton = findButton(renderer, '刷新中');
  assert.ok(loadingButton);
  assert.equal(loadingButton.props.disabled, true);
  assert.equal(loadingButton.props['aria-busy'], true);
  act(() => loadingButton.props.onClick());
  assert.equal(refreshCalls, 1, 'loading refresh must not be submitted twice');

  await act(async () => {
    finishRefresh({ ok: true });
    await Promise.resolve();
  });

  assert.ok(findButton(renderer, '已更新'), 'completed refresh must show visible success feedback');
  act(() => renderer.unmount());
});
