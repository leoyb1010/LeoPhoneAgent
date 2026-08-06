import type { SessionSendResult } from './session.js';

export type SessionDispatchOutcome =
  | { dispatched: true }
  | {
      dispatched: false;
      reason: 'cancelled-before-dispatch';
      message: string;
      context: string;
    };

export function toSessionDispatchOutcome(
  result: SessionSendResult,
  context: string,
): SessionDispatchOutcome {
  if (result.accepted) return { dispatched: true };
  return {
    dispatched: false,
    reason: result.reason,
    context,
    message: `Session send was cancelled before vendor dispatch: ${context}`,
  };
}

export function assertSendDispatched(
  result: SessionSendResult,
  context: string,
): asserts result is { accepted: true } {
  const outcome = toSessionDispatchOutcome(result, context);
  if (!outcome.dispatched) {
    throw new Error(outcome.message);
  }
}
