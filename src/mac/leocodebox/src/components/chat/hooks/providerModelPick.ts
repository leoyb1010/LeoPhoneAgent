/**
 * Composer model vs catalog. The catalog is the CLI's official list (and any
 * Leoapi extras we merged in). A stored id that is not in that list is still
 * a real user choice — API-key discovery writes those ids. Whitelisting
 * against OPTIONS used to snap them back to DEFAULT, so the picker looked
 * saved and the next send still used sonnet/gpt-5.4.
 */
export function pickStoredOrCurrent(
  stored: string | null,
  current: string,
  def: { OPTIONS: Array<{ value: string }>; DEFAULT: string },
): string {
  const remembered = (stored && stored.trim()) || (current && current.trim()) || '';
  if (remembered) return remembered;
  return def.DEFAULT;
}
