import type { AppTab } from '../../types/app';

/** Global libraries and devices remain reachable while project discovery runs. */
export function resolveWorkspaceSurface(
  tab: AppTab,
  state: { hasProject: boolean; isMobile: boolean; isLoading: boolean },
): 'collections' | 'fleet' | 'new-task' | 'loading' | 'empty' | 'project' {
  if (tab === 'collections' || tab === 'fleet') return tab;
  if (tab === 'dashboard' || (!state.isLoading && !state.hasProject && !state.isMobile && tab !== 'missions')) return 'new-task';
  if (state.isLoading) return 'loading';
  return state.hasProject ? 'project' : 'empty';
}
