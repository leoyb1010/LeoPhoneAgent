// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkerInfo } from '../hooks/useWorkers';
import { RolePillDropdown, WorkerListToolbar } from '../RolePillDropdown';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useAppShortcut', () => ({
  useAppShortcutDisplay: () => '',
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => false) }),
}));

function worker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    workerId: 'worker-a',
    sessionId: 'session-a',
    role: 'developer',
    agent: 'codex',
    model: 'gpt-5.4',
    effort: null,
    label: null,
    status: 'idle',
    focused: true,
    idleSince: null,
    ...overrides,
  };
}

describe('RolePillDropdown collaboration settings entry', () => {
  afterEach(() => {
    cleanup();
  });

  it('hides the collaboration settings link when settings are disabled for detached sidebar windows', () => {
    const current = worker();

    render(
      <RolePillDropdown
        worker={current}
        workers={[current]}
        selectedWorkerId={current.workerId}
        activeWorkerCount={5}
        softLimit={5}
        hardLimit={8}
        onSwitchFocus={vi.fn()}
        onOpenCreate={vi.fn()}
        onOpenSettings={vi.fn()}
        settingsEnabled={false}
        onArchiveWorker={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /developer/ }));

    expect(screen.queryByText('orca.rolePill.settingsCollaboration')).toBeNull();
  });

  it('keeps create worker available after the last worker is archived', () => {
    const onOpenCreate = vi.fn();
    render(
      <WorkerListToolbar
        worker={null}
        workers={[]}
        selectedWorkerId={null}
        activeWorkerCount={0}
        softLimit={5}
        hardLimit={8}
        onSwitchFocus={vi.fn()}
        onOpenCreate={onOpenCreate}
        onOpenSettings={vi.fn()}
        onArchiveWorker={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'orca.rolePill.createWorker' }));
    expect(onOpenCreate).toHaveBeenCalledTimes(1);
  });
});
