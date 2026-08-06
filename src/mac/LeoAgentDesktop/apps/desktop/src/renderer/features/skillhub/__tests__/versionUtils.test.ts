import { describe, expect, it } from 'vitest';

import { latestKnownVersion, pickDefaultVersion, semverCompare } from '../versionUtils';

describe('semverCompare', () => {
  it('treats missing patch or minor segments as zero', () => {
    expect(semverCompare('1.0', '1.0.0')).toBe(0);
    expect(semverCompare('1', '1.0.0')).toBe(0);
    expect(semverCompare('1.0.1', '1.0')).toBeGreaterThan(0);
  });

  it('does not return NaN for non-numeric segments', () => {
    expect(Number.isNaN(semverCompare('1.0.0', 'abc'))).toBe(false);
    expect(Number.isNaN(semverCompare('abc', 'def'))).toBe(false);
  });
});

describe('SkillHub legacy version compatibility', () => {
  it('treats legacy integer registry versions as migrated Hub versions', () => {
    expect(semverCompare('1.0.1', '1')).toBe(0);
    expect(semverCompare('1.0.1', 'v1')).toBe(0);
    expect(semverCompare('1.0.2', '2')).toBe(0);
  });

  it('still detects real Hub updates after migration normalization', () => {
    expect(semverCompare('1.0.2', '1')).toBeGreaterThan(0);
    expect(semverCompare('1.0.1', '2')).toBeLessThan(0);
  });

  it('compares two legacy integer versions correctly', () => {
    expect(semverCompare('1', '2')).toBeLessThan(0);
    expect(semverCompare('v2', 'v1')).toBeGreaterThan(0);
    expect(semverCompare('3', '3')).toBe(0);
  });
});

describe('publish version defaults', () => {
  it('bumps from the higher pending review version', () => {
    expect(latestKnownVersion('1.0.0', { version: '1.0.1', status: 'scanning' })).toBe('1.0.1');
    expect(pickDefaultVersion('1.0.1', '1.0.0', { version: '1.0.1', status: 'scanning' })).toBe('1.0.2');
  });

  it('reuses a rejected version instead of bumping it', () => {
    expect(latestKnownVersion('1.0.0', { version: '1.0.1', status: 'rejected' })).toBe('1.0.0');
    expect(pickDefaultVersion('1.0.1', '1.0.0', { version: '1.0.1', status: 'rejected' })).toBe('1.0.1');
  });

  it('reuses a rejected latest version when Hub exposes review state at the top level', () => {
    expect(latestKnownVersion('1.0.1', null, 'rejected')).toBeNull();
    expect(pickDefaultVersion('1.0.1', '1.0.1', null, 'rejected')).toBe('1.0.1');
    expect(pickDefaultVersion('1.0.0', '1.0.1', null, 'rejected')).toBe('1.0.1');
    expect(pickDefaultVersion(undefined, '1.0.1', null, 'rejected')).toBe('1.0.1');
  });

  it('keeps an explicitly higher local frontmatter version', () => {
    expect(pickDefaultVersion('2.0.0', '1.0.0', { version: '1.0.1', status: 'scanning' })).toBe('2.0.0');
  });
});
