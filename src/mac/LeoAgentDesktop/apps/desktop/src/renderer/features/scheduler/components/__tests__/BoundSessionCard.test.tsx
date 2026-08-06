// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoundSessionCard } from '../BoundSessionCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe('BoundSessionCard 会话引用状态', () => {
  it('持续会话被删除后说明自动续绑，隐藏打开入口并保留解除绑定', () => {
    const onOpen = vi.fn();
    const onUnbind = vi.fn();
    render(
      <BoundSessionCard
        sessionId="session-deleted"
        onOpen={onOpen}
        onUnbind={onUnbind}
        reference={{
          sessionId: 'session-deleted',
          state: 'deleted',
          status: 'deleted',
          agentKind: 'cc',
        }}
      />,
    );

    expect(screen.getByText('scheduler.editor.runSession.card.deleted')).toBeTruthy();
    expect(screen.getByText('scheduler.editor.runSession.card.deletedPersistentNote')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'scheduler.editor.runSession.card.open' }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'scheduler.editor.runSession.card.unbind' }),
    );
    expect(onUnbind).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
