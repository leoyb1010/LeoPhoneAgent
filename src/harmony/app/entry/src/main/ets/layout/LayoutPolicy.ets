export type LayoutSize = 'sm' | 'md' | 'lg';
export class LayoutState {
  size: LayoutSize = 'sm';
  inspector: boolean = false;
  manualAt: number = -1500;
}
/** Pure policy: window width only. Keyboard/safe areas never change the breakpoint. */
export function layoutSize(width: number): LayoutSize {
  if (!Number.isFinite(width) || width < 600) return 'sm';
  return width < 840 ? 'md' : 'lg';
}
export function resolveLayout(previous: LayoutState, width: number, now: number): LayoutState {
  const next = new LayoutState();
  next.size = layoutSize(width);
  next.manualAt = previous.manualAt;
  next.inspector = next.size === 'lg' && (now - previous.manualAt < 1500 || previous.size === next.size ? previous.inspector : true);
  return next;
}
export function toggleInspector(previous: LayoutState, now: number): LayoutState {
  const next = new LayoutState(); next.size = previous.size;
  next.inspector = !previous.inspector; next.manualAt = now; return next;
}
