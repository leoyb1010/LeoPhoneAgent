export type DictationExternalTextContext = {
  selectionBefore: string;
  selectedText: string;
  selectionAfter: string;
  /**
   * Full focused-editor value when the native platform can provide it cheaply.
   * External apps may move the caret after the user edits, so cursor-side text
   * alone can stop bracketing the originally pasted range. Full-field text lets
   * the same anchor logic search the whole input box while retaining the
   * bounded side-context fallback for large or AX-blind editors.
   */
  fullFieldContent?: string | null;
  selectionLocation?: number | null;
  selectionLength?: number | null;
};

export type DictationExternalEditedTextInput = {
  originalContext: DictationExternalTextContext;
  currentContext: DictationExternalTextContext;
  insertedText: string;
  anchorChars?: number;
  minAnchorChars?: number;
};

export type DictationExternalEditedTextReason =
  | 'edited_text_extracted'
  | 'replacement_text_extracted'
  | 'approximate_replacement_text_extracted'
  | 'empty_window'
  | 'unchanged'
  | 'inserted_text_still_present'
  | 'missing_anchors'
  | 'weak_left_anchor'
  | 'weak_right_anchor'
  | 'left_anchor_not_found'
  | 'right_anchor_not_found'
  | 'empty_edited_text'
  | 'edited_text_too_long';

export type DictationExternalEditedTextResult = {
  ok: boolean;
  reason: DictationExternalEditedTextReason;
  editedText?: string;
  expectedWindowChars: number;
  currentWindowChars: number;
  insertedChars: number;
  leftAnchorChars: number;
  rightAnchorChars: number;
};

const DEFAULT_EXTERNAL_ANCHOR_CHARS = 80;
const DEFAULT_EXTERNAL_MIN_ANCHOR_CHARS = 2;

/**
 * Recovers the current edited form of text we pasted into an external app.
 *
 * External editors do not report "the user changed this exact pasted range" to
 * us. We therefore use the read-only text around the original cursor as anchors
 * and only inspect a narrow replacement window. Dictionary decisions are made by
 * the advisor LLM; this helper only decides whether we have reliable edit
 * evidence to send.
 */
export function inspectExternalEditedInsertedText(
  input: DictationExternalEditedTextInput,
): DictationExternalEditedTextResult {
  const expectedWindow = buildExpectedWindow(input.originalContext, input.insertedText);
  const currentWindow = buildCurrentWindow(input.currentContext);

  const anchorChars = input.anchorChars ?? DEFAULT_EXTERNAL_ANCHOR_CHARS;
  const minAnchorChars = input.minAnchorChars ?? DEFAULT_EXTERNAL_MIN_ANCHOR_CHARS;
  const leftAnchor = takeTextTail(input.originalContext.selectionBefore, anchorChars);
  const rightAnchor = takeTextHead(input.originalContext.selectionAfter, anchorChars);
  const baseResult = {
    expectedWindowChars: expectedWindow.length,
    currentWindowChars: currentWindow.length,
    insertedChars: input.insertedText.length,
    leftAnchorChars: leftAnchor.length,
    rightAnchorChars: rightAnchor.length,
  };

  if (!expectedWindow || !currentWindow) {
    return { ok: false, reason: 'empty_window', ...baseResult };
  }
  if (currentWindow === expectedWindow) {
    return { ok: false, reason: 'unchanged', ...baseResult };
  }
  if (currentWindow.includes(input.insertedText)) {
    return { ok: false, reason: 'inserted_text_still_present', ...baseResult };
  }

  const hasLeftAnchor = leftAnchor.length >= minAnchorChars;
  const hasRightAnchor = rightAnchor.length >= minAnchorChars;
  if (!hasLeftAnchor && !hasRightAnchor) {
    const replacementResult = inspectReplacementEditedText(input, currentWindow, baseResult);
    if (replacementResult) return replacementResult;
    return { ok: false, reason: 'missing_anchors', ...baseResult };
  }
  if (!hasLeftAnchor && input.originalContext.selectionBefore.length > 0) {
    const replacementResult = inspectReplacementEditedText(input, currentWindow, baseResult);
    if (replacementResult) return replacementResult;
    return { ok: false, reason: 'weak_left_anchor', ...baseResult };
  }
  if (!hasRightAnchor && input.originalContext.selectionAfter.length > 0) {
    const replacementResult = inspectReplacementEditedText(input, currentWindow, baseResult);
    if (replacementResult) return replacementResult;
    return { ok: false, reason: 'weak_right_anchor', ...baseResult };
  }

  const leftIndex = hasLeftAnchor ? currentWindow.lastIndexOf(leftAnchor) : 0;
  if (leftIndex < 0) {
    const replacementResult = inspectReplacementEditedText(input, currentWindow, baseResult);
    if (replacementResult) return replacementResult;
    const approximateResult = inspectApproximateEditedText(input, currentWindow, baseResult);
    if (approximateResult) return approximateResult;
    return { ok: false, reason: 'left_anchor_not_found', ...baseResult };
  }
  const start = hasLeftAnchor ? leftIndex + leftAnchor.length : 0;
  const end = hasRightAnchor
    ? currentWindow.indexOf(rightAnchor, start)
    : currentWindow.length;
  if (end < start) {
    const replacementResult = inspectReplacementEditedText(input, currentWindow, baseResult);
    if (replacementResult) return replacementResult;
    const approximateResult = inspectApproximateEditedText(input, currentWindow, baseResult);
    if (approximateResult) return approximateResult;
    return { ok: false, reason: 'right_anchor_not_found', ...baseResult };
  }

  const edited = currentWindow.slice(start, end).trim();
  if (!edited) {
    return { ok: false, reason: 'empty_edited_text', ...baseResult };
  }
  if (edited.length > input.insertedText.length + 80) {
    return { ok: false, reason: 'edited_text_too_long', ...baseResult };
  }
  return {
    ok: true,
    reason: 'edited_text_extracted',
    editedText: edited,
    ...baseResult,
  };
}

function buildExpectedWindow(context: DictationExternalTextContext, insertedText: string): string {
  const fullField = context.fullFieldContent;
  if (
    typeof fullField === 'string' &&
    Number.isFinite(context.selectionLocation) &&
    Number.isFinite(context.selectionLength)
  ) {
    const location = clampIndex(context.selectionLocation ?? 0, fullField.length);
    const length = Math.max(0, Math.min(context.selectionLength ?? 0, fullField.length - location));
    return `${fullField.slice(0, location)}${insertedText}${fullField.slice(location + length)}`;
  }
  return [
    context.selectionBefore,
    insertedText,
    context.selectionAfter,
  ].join('');
}

function buildCurrentWindow(context: DictationExternalTextContext): string {
  if (typeof context.fullFieldContent === 'string') return context.fullFieldContent;
  return [
    context.selectionBefore,
    context.selectedText,
    context.selectionAfter,
  ].join('');
}

function clampIndex(value: number, max: number): number {
  return Math.max(0, Math.min(Math.floor(value), max));
}

function inspectReplacementEditedText(
  input: DictationExternalEditedTextInput,
  currentWindow: string,
  baseResult: Omit<DictationExternalEditedTextResult, 'ok' | 'reason' | 'editedText'>,
): DictationExternalEditedTextResult | null {
  const hadLeftContext = input.originalContext.selectionBefore.trim().length > 0;
  const hadRightContext = input.originalContext.selectionAfter.trim().length > 0;
  if (hadLeftContext && hadRightContext) return null;

  const edited = currentWindow.trim();
  if (!edited) return null;
  if (edited === input.insertedText.trim()) return null;
  if (edited.length > input.insertedText.length + 80) return null;

  return {
    ok: true,
    reason: 'replacement_text_extracted',
    editedText: edited,
    ...baseResult,
  };
}

function inspectApproximateEditedText(
  input: DictationExternalEditedTextInput,
  currentWindow: string,
  baseResult: Omit<DictationExternalEditedTextResult, 'ok' | 'reason' | 'editedText'>,
): DictationExternalEditedTextResult | null {
  const edited = cleanExternalEditableText(currentWindow);
  const inserted = cleanExternalEditableText(input.insertedText);
  if (!edited || !inserted || edited === inserted) return null;
  if (edited.length > inserted.length + 80) return null;
  if (!hasStrongInsertedTextOverlap(inserted, edited)) return null;

  return {
    ok: true,
    reason: 'approximate_replacement_text_extracted',
    editedText: edited,
    ...baseResult,
  };
}

function cleanExternalEditableText(text: string): string {
  return text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function hasStrongInsertedTextOverlap(inserted: string, edited: string): boolean {
  const insertedChars = Array.from(inserted);
  const editedChars = Array.from(edited);
  if (insertedChars.length < 6 || editedChars.length < 6) return false;
  const minOverlap = Math.min(12, Math.max(5, Math.ceil(insertedChars.length * 0.45)));
  return longestCommonSubstringLength(insertedChars, editedChars) >= minOverlap;
}

function longestCommonSubstringLength(a: string[], b: string[]): number {
  let best = 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = previous[j - 1] + 1;
        best = Math.max(best, current[j]);
      }
    }
    previous = current;
  }
  return best;
}

function takeTextTail(text: string | null | undefined, maxChars: number): string {
  const value = text ?? '';
  return value.length > maxChars ? value.slice(value.length - maxChars) : value;
}

function takeTextHead(text: string | null | undefined, maxChars: number): string {
  const value = text ?? '';
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}
