// Shim: openclaw/plugin-sdk/string-coerce-runtime → vendored normalization-core.
export {
  hasNonEmptyString,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue,
} from '../_generated/packages/normalization-core/string-coerce.js';
export { asNullableRecord, isRecord } from '../_generated/packages/normalization-core/record-coerce.js';
export {
  normalizeOptionalTrimmedStringList,
  uniqueStrings,
  uniqueValues,
} from '../_generated/packages/normalization-core/string-normalization.js';
