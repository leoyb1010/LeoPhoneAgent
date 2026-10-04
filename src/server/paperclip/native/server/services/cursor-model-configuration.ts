export const CURSOR_INVALID_MODEL_ERROR_CODE = "cursor_model_invalid";

/** A CLI model-selection rejection is permanent until the configured ID changes. */
export function isCursorInvalidModelError(adapterType: string, errorMessage: unknown): boolean {
  return adapterType === "cursor" && typeof errorMessage === "string" &&
    /^(?:Error:\s*)?Cannot use this model:\s*\S+/i.test(errorMessage.trim());
}
