import { describe, expect, it } from 'vitest';

import { marketVisibilityLabelKey, marketVisibilitySubtitleKey } from '../marketVisibility';

describe('marketVisibilityLabelKey', () => {
  it('keeps existing public and department labels', () => {
    expect(marketVisibilityLabelKey({
      visibility: 'PUBLIC',
      publishedVisibility: 'public',
    })).toBe('skillhub.marketCard.visibilityPublic');

    expect(marketVisibilityLabelKey({
      visibility: 'DEPARTMENT_SCOPED',
      publishedVisibility: 'shared',
    })).toBe('skillhub.marketCard.visibilityDept');
  });

  it('only shows the private label in My Published cloud-management context', () => {
    expect(marketVisibilityLabelKey({
      visibility: 'DEPARTMENT_SCOPED',
      publishedVisibility: 'private',
      allowPrivateLabel: true,
    })).toBe('skillhub.marketCard.visibilityPrivate');

    expect(marketVisibilityLabelKey({
      visibility: 'DEPARTMENT_SCOPED',
      publishedVisibility: 'private',
    })).toBe('skillhub.marketCard.visibilityDept');
  });

  it('does not duplicate visible wording in the cloud detail subtitle', () => {
    expect(marketVisibilitySubtitleKey({
      visibility: 'PUBLIC',
      publishedVisibility: 'public',
      allowPrivateLabel: true,
    })).toBe('skillhub.marketDetail.visibilityPublic');

    expect(marketVisibilitySubtitleKey({
      visibility: 'DEPARTMENT_SCOPED',
      publishedVisibility: 'shared',
      allowPrivateLabel: true,
    })).toBe('skillhub.marketDetail.visibilityDept');

    expect(marketVisibilitySubtitleKey({
      visibility: 'DEPARTMENT_SCOPED',
      publishedVisibility: 'private',
      allowPrivateLabel: true,
    })).toBe('skillhub.marketDetail.visibilityPrivate');
  });
});
