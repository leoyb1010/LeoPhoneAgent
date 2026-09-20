export function canSetAllSpaces(desktop?: { setVisibleOnAllWorkspaces?: unknown; getVisibleOnAllWorkspaces?: unknown } | null): boolean {
  return Boolean(desktop?.setVisibleOnAllWorkspaces || desktop?.getVisibleOnAllWorkspaces);
}

export function allSpacesToast(on: boolean): string {
  return on ? '已在每个桌面都在' : '只留在这个桌面';
}

export function allSpacesLabel(on: boolean): string {
  return on ? '不要每个桌面' : '每个桌面都在';
}
