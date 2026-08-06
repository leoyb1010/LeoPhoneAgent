export interface SkillhubUserTeam {
  slug: string;
  type?: string;
  source?: string | null;
  isPersonal?: boolean;
}

export function isMaterializedDepartmentTeam(
  team: Pick<SkillhubUserTeam, 'slug' | 'source'>,
): boolean {
  // Legacy department mirrors are recognized by their source metadata; a
  // regular team slug alone is never enough to classify it as a department.
  return (
    team.source === 'dept' ||
    team.source === 'xdt-maker' ||
    team.slug.startsWith('od-')
  );
}

/** Keep ordinary teams in server order while removing duplicate slugs. */
export function selectableUserTeams<T extends SkillhubUserTeam>(teams: readonly T[]): T[] {
  const seenSlugs = new Set<string>();
  return teams.filter((team) => {
    if (
      team.isPersonal ||
      team.type === 'personal' ||
      isMaterializedDepartmentTeam(team) ||
      seenSlugs.has(team.slug)
    ) {
      return false;
    }
    seenSlugs.add(team.slug);
    return true;
  });
}
