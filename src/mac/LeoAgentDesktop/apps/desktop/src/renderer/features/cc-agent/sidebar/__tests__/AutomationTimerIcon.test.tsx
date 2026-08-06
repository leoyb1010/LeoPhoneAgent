// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AutomationTimerIcon } from '../AutomationTimerIcon';

afterEach(cleanup);

describe('AutomationTimerIcon', () => {
  it('keeps the Timer in a fixed slot for active and paused tasks', () => {
    const { container, rerender } = render(<AutomationTimerIcon />);
    const activeSlot = container.querySelector('[data-automation-timer-icon="true"]');

    expect(activeSlot?.className).toContain('size-3');
    expect(activeSlot?.querySelector('.lucide-timer')).not.toBeNull();
    expect(activeSlot?.querySelector('[data-automation-paused-indicator="true"]')).toBeNull();

    rerender(<AutomationTimerIcon paused />);
    const pausedSlot = container.querySelector('[data-automation-timer-icon="true"]');
    const pausedTimer = pausedSlot?.querySelector('.lucide-timer');

    expect(pausedSlot?.className).toContain('size-3');
    expect(pausedTimer).not.toBeNull();
    expect(pausedTimer?.getAttribute('class')).not.toMatch(/\bopacity-/);
    expect(pausedSlot?.querySelector('.lucide-pause')).not.toBeNull();
  });
});
