import { describe, expect, it } from 'vitest';

import { isMaterializedDepartmentTeam, selectableUserTeams } from '../userTeams';

describe('isMaterializedDepartmentTeam', () => {
  it('recognizes both explicit source metadata and reserved department slugs', () => {
    expect(isMaterializedDepartmentTeam({ slug: 'legacy-dept', source: 'dept' })).toBe(true);
    expect(isMaterializedDepartmentTeam({ slug: 'od-platform', source: null })).toBe(true);
    expect(isMaterializedDepartmentTeam({ slug: 'dept-od-platform', source: 'xdt-maker' })).toBe(true);
    expect(isMaterializedDepartmentTeam({ slug: 'dept-od-platform', source: null })).toBe(false);
    expect(isMaterializedDepartmentTeam({ slug: 'platform', source: null })).toBe(false);
  });
});

describe('selectableUserTeams', () => {
  it('keeps ordinary teams in stable order and removes personal, department, and duplicate entries', () => {
    const firstPlatform = { slug: 'platform', name: 'Platform', source: null, isPersonal: false };
    const teams = [
      firstPlatform,
      { slug: 'personal-sunyi', name: 'Sunyi', source: null, isPersonal: true },
      { slug: 'personal-legacy', name: 'Legacy Personal', type: 'personal', source: null },
      { slug: 'od-platform', name: 'Platform Dept', source: 'dept', isPersonal: false },
      { slug: 'od-legacy', name: 'Legacy Dept', source: null, isPersonal: false },
      { slug: 'platform', name: 'Duplicate Platform', source: null, isPersonal: false },
      { slug: 'sdk', name: 'SDK', source: null, isPersonal: false },
    ];

    const result = selectableUserTeams(teams);

    expect(result).toEqual([
      firstPlatform,
      { slug: 'sdk', name: 'SDK', source: null, isPersonal: false },
    ]);
    expect(result[0]).toBe(firstPlatform);
  });
});
