// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/features/right-sidebar/RightSidebarShell', () => ({
  RightSidebarShell: () => null,
}));

import { CHROME_ACTIONS_GEOMETRY } from '../chromeActionsGeometry';
import { RightSidebar } from '../RightSidebar';

/** 渲染只覆盖 titlebar app-region 结构与面板位置分流所需的最小 props。 */
function renderSidebar(isMac: boolean, panelSide: 'left' | 'right'): void {
  render(
    <RightSidebar
      isCollapsed={false}
      width={320}
      isMac={isMac}
      sessionId="session-a"
      workdir="/repo"
      remoteHostId={null}
      panelSide={panelSide}
    />,
  );
}

describe('RightSidebar Windows chrome actions hit hole', () => {
  it('keeps a descendant no-drag hole aligned with the floating ChromeActions', () => {
    renderSidebar(false, 'left');

    const spacer = screen.getByTestId('right-sidebar-titlebar-spacer');
    const hitHole = screen.getByTestId('right-sidebar-chrome-actions-hit-hole');

    expect(spacer.contains(hitHole)).toBe(true);
    expect(
      (spacer.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion,
    ).toBe('drag');
    expect(
      (hitHole.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion,
    ).toBe('no-drag');
    expect(hitHole.style.marginLeft).toBe(`${CHROME_ACTIONS_GEOMETRY.defaultLeft}px`);
    expect(hitHole.style.width).toBe(`${CHROME_ACTIONS_GEOMETRY.clusterWidth}px`);
  });

  it('keeps the whole Windows titlebar draggable when the panel is on the right', () => {
    renderSidebar(false, 'right');

    const spacer = screen.getByTestId('right-sidebar-titlebar-spacer');
    expect(
      (spacer.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion,
    ).toBe('drag');
    expect(screen.queryByTestId('right-sidebar-chrome-actions-hit-hole')).toBeNull();
  });

  it('does not add the Windows-only hit hole on macOS', () => {
    renderSidebar(true, 'left');

    expect(screen.queryByTestId('right-sidebar-titlebar-spacer')).toBeNull();
    expect(screen.queryByTestId('right-sidebar-chrome-actions-hit-hole')).toBeNull();
  });
});
