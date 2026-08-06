import { describe, expect, it } from 'vitest';

import {
  isTerminalAgentErrorEvent,
  isTerminalTurnEvent,
  type AgentEvent,
} from './events.js';

describe('AgentEvent terminal predicates', () => {
  it('uses one shared fallback rule for agent error terminal state', () => {
    expect(isTerminalAgentErrorEvent({ type: 'error', data: { message: 'done', isTerminal: true } })).toBe(true);
    expect(isTerminalAgentErrorEvent({ type: 'error', data: { message: 'retry', isTerminal: false } })).toBe(false);
    expect(isTerminalAgentErrorEvent({ type: 'error', data: { message: 'retry', willRetry: true } })).toBe(false);
    expect(isTerminalAgentErrorEvent({ type: 'error', data: { message: 'legacy' } })).toBe(true);
  });

  it('classifies full turn terminal events from the same shared helper', () => {
    const terminalError: AgentEvent = { type: 'error', data: { message: 'done', isTerminal: true } };
    const retryableError: AgentEvent = { type: 'error', data: { message: 'retry', willRetry: true } };

    expect(isTerminalTurnEvent({ type: 'done', data: {} })).toBe(true);
    expect(isTerminalTurnEvent({ type: 'status', data: { isRunning: false } })).toBe(true);
    expect(isTerminalTurnEvent(terminalError)).toBe(true);
    expect(isTerminalTurnEvent(retryableError)).toBe(false);
    expect(isTerminalTurnEvent({ type: 'text', data: { text: 'still running' } })).toBe(false);
  });
});
