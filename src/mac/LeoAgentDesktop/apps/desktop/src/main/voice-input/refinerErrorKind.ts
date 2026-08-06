/**
 * Error classification for the refiner fallback path.
 *
 * The refiner clients throw two distinct classes of error:
 * - transport: network failure, idle timeout, HTTP error, auth failure —
 *   the service channel itself is unhealthy. These feed the sticky-failover
 *   cooldown so subsequent dictations route around the provider.
 * - model-output: the request succeeded but the model produced unusable
 *   output (malformed JSON, empty content, runaway length). The channel is
 *   healthy; FallbackTextModelClient still tries the next model to rescue the
 *   current refinement, but must NOT push the provider into cooldown over a
 *   single bad generation.
 *
 * Unmarked errors default to transport: that keeps the conservative existing
 * behavior (failover + cooldown) for anything unforeseen, and makes
 * model-output the explicit opt-in special case.
 */
const REFINER_MODEL_OUTPUT_ERROR_FLAG = '__voiceInputRefinerModelOutputError';

export function markRefinerModelOutputError(error: unknown): unknown {
  // Non-object throw values (e.g. a string throw from a downstream lib)
  // cannot carry the flag — wrap them in an Error so the classification is
  // never silently dropped into the transport (cooldown) path.
  const target = error && typeof error === 'object' ? error : new Error(String(error));
  (target as Record<string, unknown>)[REFINER_MODEL_OUTPUT_ERROR_FLAG] = true;
  return target;
}

export function isRefinerModelOutputError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as Record<string, unknown>)[REFINER_MODEL_OUTPUT_ERROR_FLAG] === true,
  );
}

const MAX_CAUSE_DEPTH = 3;

/**
 * Formats an error message including its `cause` chain for logs.
 *
 * undici wraps every network-level failure in a bare `fetch failed` TypeError
 * and hides the actionable detail (ETIMEDOUT, ECONNREFUSED, TLS alerts…) in
 * `error.cause` — often as an error whose `message` is empty and only `code`
 * is set. Logging just `error.message` therefore destroys the one clue that
 * distinguishes "endpoint down" from "local network path broken".
 */
export function describeErrorWithCause(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts: string[] = [describeSingleError(error)];
  let cause: unknown = error.cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cause !== undefined && cause !== null; depth += 1) {
    if (cause instanceof Error) {
      parts.push(describeSingleError(cause));
      cause = cause.cause;
    } else {
      parts.push(String(cause));
      break;
    }
  }
  return parts.filter(Boolean).join(' <- ');
}

function describeSingleError(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code && !error.message.includes(String(code))) {
    return error.message ? `${error.message} (${code})` : String(code);
  }
  return error.message;
}
