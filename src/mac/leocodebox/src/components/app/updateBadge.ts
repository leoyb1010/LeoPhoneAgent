export type UpdateBadgeTone = 'update' | 'restart';

export type UpdateBadge = {
  show: boolean;
  tone: UpdateBadgeTone | null;
};

/**
 * Decide the status-bar update dot. `updateAvailable` wins over `restartRequired`
 * because clicking it opens the update card (which offers download/install);
 * a bare restart-required state is a lower-priority hint.
 */
export function resolveUpdateBadge(updateAvailable: boolean, restartRequired: boolean): UpdateBadge {
  if (updateAvailable) return { show: true, tone: 'update' };
  if (restartRequired) return { show: true, tone: 'restart' };
  return { show: false, tone: null };
}
