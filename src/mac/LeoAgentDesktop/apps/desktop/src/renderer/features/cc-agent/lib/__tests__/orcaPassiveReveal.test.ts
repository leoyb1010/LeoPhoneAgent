import { describe, expect, it } from 'vitest';

import {
  shouldRevealOrcaWorkersAfterPaint,
  shouldRevealOrcaWorkersBeforeFirstPaint,
} from '../orcaPassiveReveal';

const base = {
  collabEnabled: true,
  ownsRoute: true,
  isCompactRail: false,
  hasExplicitReveal: false,
  collapsedRecord: null as boolean | null,
};

describe('orca passive workers reveal decisions', () => {
  it('opens before first paint only when sync identity is available and the session has no collapsed record', () => {
    expect(
      shouldRevealOrcaWorkersBeforeFirstPaint({
        ...base,
        hasSynchronousSessionIdentity: true,
      }),
    ).toBe(true);
  });

  it('does not first-frame open when the user has an explicit collapsed record', () => {
    expect(
      shouldRevealOrcaWorkersBeforeFirstPaint({
        ...base,
        collapsedRecord: true,
        hasSynchronousSessionIdentity: true,
      }),
    ).toBe(false);
    expect(
      shouldRevealOrcaWorkersBeforeFirstPaint({
        ...base,
        collapsedRecord: false,
        hasSynchronousSessionIdentity: true,
      }),
    ).toBe(false);
  });

  it('keeps async identity paths in the after-paint reveal fallback', () => {
    expect(
      shouldRevealOrcaWorkersBeforeFirstPaint({
        ...base,
        hasSynchronousSessionIdentity: false,
      }),
    ).toBe(false);
    expect(shouldRevealOrcaWorkersAfterPaint(base)).toBe(true);
  });

  it('does not passively reveal for explicit worker links or embedded rails', () => {
    expect(
      shouldRevealOrcaWorkersBeforeFirstPaint({
        ...base,
        hasExplicitReveal: true,
        hasSynchronousSessionIdentity: true,
      }),
    ).toBe(false);
    expect(
      shouldRevealOrcaWorkersAfterPaint({
        ...base,
        isCompactRail: true,
      }),
    ).toBe(false);
  });
});
