// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AvailableShell, ShellId } from '../../../../shared/terminal-bridge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { target?: string; shell?: string }) => {
      const value = params?.target ?? params?.shell;
      return value ? `${key}:${value}` : key;
    },
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('../DefaultOverrideControls', () => ({
  DefaultOverrideControls: () => null,
}));

import { TerminalShellSection } from '../TerminalShellSection';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function shell(
  id: AvailableShell['id'],
  displayName: string,
  isAutoDetectTarget = false,
): AvailableShell {
  return { id, command: `/bin/${id}`, displayName, isAutoDetectTarget };
}

function installTerminalApi(options: {
  pref: Promise<ShellId>;
  shells: Promise<AvailableShell[]>;
}) {
  const getDefaultShellPref = vi.fn(() => options.pref);
  const listAvailableShells = vi.fn(() => options.shells);
  const setDefaultShellPref = vi.fn(async () => {});
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      terminal: {
        getDefaultShellPref,
        listAvailableShells,
        setDefaultShellPref,
      },
    } as unknown as Window['electronAPI'],
  });
  return { getDefaultShellPref, listAvailableShells, setDefaultShellPref };
}

async function openSelect(): Promise<void> {
  const trigger = screen.getByRole('combobox');
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown', code: 'ArrowDown' });
  await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
}

describe('TerminalShellSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('prefetches preference and shells once, then first opens with the complete list', async () => {
    const prefRequest = deferred<ShellId>();
    const shellsRequest = deferred<AvailableShell[]>();
    const api = installTerminalApi({ pref: prefRequest.promise, shells: shellsRequest.promise });

    render(<TerminalShellSection />);

    expect(api.getDefaultShellPref).toHaveBeenCalledOnce();
    expect(api.listAvailableShells).toHaveBeenCalledOnce();
    expect(screen.queryByRole('combobox')).toBeNull();

    await act(async () => prefRequest.resolve('auto'));
    expect(screen.queryByRole('combobox')).toBeNull();

    await act(async () => {
      shellsRequest.resolve([
        shell('zsh', 'Zsh', true),
        shell('bash', 'Bash'),
        shell('pwsh', 'PowerShell'),
      ]);
    });

    await openSelect();
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'settings.terminalShell.autoWithTarget:Zsh',
      'Zsh',
      'Bash',
      'PowerShell',
    ]);
    expect(api.getDefaultShellPref).toHaveBeenCalledOnce();
    expect(api.listAvailableShells).toHaveBeenCalledOnce();
  });

  it('falls back to auto when both startup requests fail', async () => {
    const api = installTerminalApi({
      pref: Promise.reject(new Error('pref unavailable')),
      shells: Promise.reject(new Error('probe unavailable')),
    });

    render(<TerminalShellSection />);

    const trigger = await screen.findByRole('combobox');
    expect(trigger.textContent).toContain('settings.terminalShell.auto');
    await openSelect();
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(api.listAvailableShells).toHaveBeenCalledOnce();
  });

  it('keeps an unavailable saved shell visible so the user can switch back to auto', async () => {
    installTerminalApi({
      pref: Promise.resolve('fish'),
      shells: Promise.resolve([shell('zsh', 'Zsh', true), shell('bash', 'Bash')]),
    });

    render(<TerminalShellSection />);

    expect((await screen.findByRole('combobox')).textContent).toContain(
      'settings.terminalShell.unavailable:fish',
    );
    await openSelect();
    expect(
      screen.getByRole('option', { name: 'settings.terminalShell.unavailable:fish' }),
    ).toBeTruthy();
  });

  it('persists a shell selected from the Radix menu', async () => {
    const api = installTerminalApi({
      pref: Promise.resolve('auto'),
      shells: Promise.resolve([shell('zsh', 'Zsh', true), shell('bash', 'Bash')]),
    });
    render(<TerminalShellSection />);

    await screen.findByRole('combobox');
    await openSelect();
    fireEvent.click(screen.getByRole('option', { name: 'Bash' }));

    await waitFor(() => expect(api.setDefaultShellPref).toHaveBeenCalledWith('bash'));
    expect(screen.getByRole('combobox').textContent).toContain('Bash');
  });

  it('ignores prefetched results after unmount', async () => {
    const prefRequest = deferred<ShellId>();
    const shellsRequest = deferred<AvailableShell[]>();
    installTerminalApi({ pref: prefRequest.promise, shells: shellsRequest.promise });
    const view = render(<TerminalShellSection />);

    view.unmount();
    await act(async () => {
      prefRequest.resolve('bash');
      shellsRequest.resolve([shell('bash', 'Bash', true)]);
    });

    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
