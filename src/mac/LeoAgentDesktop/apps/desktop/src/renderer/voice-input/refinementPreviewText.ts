/**
 * Keep submitted ASR text visible while streaming refinement arrives.
 *
 * The refiner streams a current refined prefix, not a diff against the ASR
 * text. Until the final refined text is ready, preserve the raw suffix by
 * length so in-app input and the global overlay share the same gradual
 * replacement behavior instead of clearing the whole transcript and typing the
 * refined text from scratch.
 */
export function buildRefinementPreviewText(baseText: string, previewText: string): string {
  if (!previewText) return baseText;
  if (!baseText || previewText.length >= baseText.length) return previewText;
  return `${previewText}${baseText.slice(previewText.length)}`;
}
