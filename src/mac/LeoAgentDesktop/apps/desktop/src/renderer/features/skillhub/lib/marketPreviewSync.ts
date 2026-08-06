import type { MarketSkill } from '../hooks/useMarketList';

export interface MarketPreviewSelectionState {
  previewSkill: MarketSkill | null;
  selectedName: string | null;
}

export function syncMarketPreviewSelection(
  state: MarketPreviewSelectionState,
  items: MarketSkill[],
): MarketPreviewSelectionState {
  const name = state.previewSkill?.name;
  if (!name) return state;
  const latest = items.find((item) => item.name === name) ?? null;
  return {
    previewSkill: latest,
    selectedName: latest?.name ?? null,
  };
}
