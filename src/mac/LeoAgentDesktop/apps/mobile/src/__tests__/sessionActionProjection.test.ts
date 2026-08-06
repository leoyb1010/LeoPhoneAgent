import { describe, expect, it } from 'vitest';
import { projectMobileSessionActions } from '@/session/sessionActionProjection';
import type { SessionActionStripAction, SessionActionStripActionId } from '@/session/sessionOverview';

function action(
  id: SessionActionStripActionId,
  patch: Partial<SessionActionStripAction> = {},
): SessionActionStripAction {
  return {
    accessibilityLabel: id,
    active: false,
    attention: false,
    disabled: false,
    disabledReason: null,
    id,
    label: id,
    testID: `session.${id}`,
    ...patch,
  };
}

describe('sessionActionProjection', () => {
  it('keeps only high-frequency enabled actions in the mobile session chrome', () => {
    const projection = projectMobileSessionActions([
      action('settings'),
      action('usage'),
      action('files'),
      action('queue', { disabled: true, disabledReason: '当前没有队列消息。' }),
      action('search'),
    ]);

    expect(projection.primaryActions.map((item) => item.id)).toEqual(['settings', 'files', 'search']);
    expect(projection.hiddenActions.map((item) => item.id)).toEqual(['usage', 'queue']);
  });

  it('keeps queue primary only when it is actionable', () => {
    const projection = projectMobileSessionActions([
      action('settings'),
      action('files'),
      action('queue', { active: true, attention: true, label: '队列' }),
      action('search'),
    ]);

    expect(projection.primaryActions.map((item) => item.id)).toEqual(['settings', 'queue', 'files', 'search']);
  });

  it('does not spend primary space on disabled files or search entries', () => {
    const projection = projectMobileSessionActions([
      action('settings'),
      action('files', { disabled: true, disabledReason: '没有工作目录。' }),
      action('search', { disabled: true, disabledReason: '没有可搜索消息。' }),
    ]);

    expect(projection.primaryActions.map((item) => item.id)).toEqual(['settings']);
    expect(projection.hiddenActions.map((item) => item.id)).toEqual(['files', 'search']);
  });
});
