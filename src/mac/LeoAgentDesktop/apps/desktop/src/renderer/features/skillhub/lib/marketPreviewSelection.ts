export function nextMarketPreviewName(currentName: string | null, clickedName: string): string | null {
  return currentName === clickedName ? null : clickedName;
}
