// @vitest-environment jsdom

/**
 * sessionRenameOutsidePointerDown.test.ts
 * ---------------------------------------------------------------------------
 * 回归覆盖(点击编辑器外任何位置 = 提交并结束编辑):
 * 点击不可聚焦区域(聊天区空白等)不会转移焦点、blur 不触发,只靠 blur
 * 编辑态会一直挂着 —— SessionRenameInput 用 document pointerdown capture
 * 做外点检测。
 * - 容器外 pointerdown → onCommit(当前 value);
 * - 容器内(input / Magic 按钮)pointerdown → 不提交;
 * - 输入修改后外点 → 提交的是最新值;
 * - 卸载后 document 监听移除,不再触发。
 */

import { createElement, useState } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionRenameInput } from '../features/cc-agent/SessionRenameInput';

vi.mock('@/lib/makerTransport', () => ({
  regenerateSessionTitleFor: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 受控 value 的最小宿主:模拟调用方的 draft state。 */
function Harness(props: { onCommit: (raw: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState('旧标题');
  return createElement(SessionRenameInput, {
    sessionId: 's1',
    value,
    onValueChange: setValue,
    onCommit: props.onCommit,
    onCancel: props.onCancel,
  });
}

describe('SessionRenameInput outside pointerdown commits', () => {
  it('pointerdown outside the container commits the current value', () => {
    const onCommit = vi.fn();
    render(createElement(Harness, { onCommit, onCancel: () => {} }));

    fireEvent.pointerDown(document.body);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('旧标题');
  });

  it('pointerdown inside the container (input / magic button) does not commit', () => {
    const onCommit = vi.fn();
    const { container } = render(createElement(Harness, { onCommit, onCancel: () => {} }));

    fireEvent.pointerDown(container.querySelector('input')!);
    fireEvent.pointerDown(container.querySelector('button')!);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits the latest edited value on outside pointerdown', () => {
    const onCommit = vi.fn();
    const { container } = render(createElement(Harness, { onCommit, onCancel: () => {} }));

    fireEvent.change(container.querySelector('input')!, { target: { value: '新标题' } });
    fireEvent.pointerDown(document.body);
    expect(onCommit).toHaveBeenCalledWith('新标题');
  });

  it('removes the document listener after unmount', () => {
    const onCommit = vi.fn();
    const { unmount } = render(createElement(Harness, { onCommit, onCancel: () => {} }));

    unmount();
    fireEvent.pointerDown(document.body);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
