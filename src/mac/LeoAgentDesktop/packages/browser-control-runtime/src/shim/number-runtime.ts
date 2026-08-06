// Shim: openclaw/plugin-sdk/number-runtime → vendored normalization-core.
export {
  MAX_TIMER_TIMEOUT_MS,
  addTimerTimeoutGraceMs,
  clampPositiveTimerTimeoutMs,
  clampTimerTimeoutMs,
  isFutureDateTimestampMs,
  parseFiniteNumber,
  parseStrictFiniteNumber,
  parseStrictInteger,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
  resolveExpiresAtMsFromDurationMs,
  resolveIntegerOption,
  resolveNonNegativeIntegerOption,
  resolveTimerTimeoutMs,
} from '../_generated/packages/normalization-core/number-coercion.js';
