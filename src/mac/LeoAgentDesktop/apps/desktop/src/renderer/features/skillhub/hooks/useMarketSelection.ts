/**
 * useMarketSelection — module-level store for the currently selected Market skill.
 *
 * Shared between SkillhubMarketListView (sets selection on card click) and
 * SkillhubSidebarUpper/MarketSelectionPanel (reads selection to show 3-state panel).
 *
 * Pattern mirrors historyStack in useSkillhub: module-level singleton + useSyncExternalStore.
 * This survives FadeSwitcher remounts without losing state.
 */

import { useSyncExternalStore } from 'react';
import type { MarketSkill } from './useMarketList';

let selected: MarketSkill | null = null;
const listeners = new Set<() => void>();

/** Set the selected skill (module-level, safe to call outside React components). */
export function setMarketSelected(skill: MarketSkill | null): void {
  if (selected === skill) return;
  selected = skill;
  for (const l of listeners) l();
}

/** Read current selection synchronously (for initial state outside React render). */
export function getMarketSelected(): MarketSkill | null {
  return selected;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): MarketSkill | null {
  return selected;
}

export function useMarketSelection(): {
  selectedSkill: MarketSkill | null;
  setSelected: (s: MarketSkill | null) => void;
} {
  const selectedSkill = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { selectedSkill, setSelected: setMarketSelected };
}
