import { describe, expect, it } from 'vitest';

import { isClaudeResumeSessionNotFound } from '../invalid-resume.js';

describe('isClaudeResumeSessionNotFound', () => {
  it('accepts the exact CLI missing-conversation error for the expected id', () => {
    expect(
      isClaudeResumeSessionNotFound(
        new Error('Claude Code returned an error result: No conversation found with session ID: dead-beef'),
        'dead-beef',
      ),
    ).toBe(true);
  });

  it('accepts the SDK result and assistant-envelope shapes', () => {
    expect(
      isClaudeResumeSessionNotFound(
        {
          type: 'result',
          is_error: true,
          result: 'No conversation found with session ID',
        },
        'dead-beef',
      ),
    ).toBe(true);
    expect(
      isClaudeResumeSessionNotFound(
        {
          type: 'assistant',
          error: 'invalid_request',
          message: {
            content: [
              {
                type: 'text',
                text: 'No conversation found with session ID: dead-beef',
              },
            ],
          },
        },
        'dead-beef',
      ),
    ).toBe(true);
  });

  it('rejects a different id and unrelated 404/auth/network failures', () => {
    expect(isClaudeResumeSessionNotFound('No conversation found with session ID: another-session', 'dead-beef')).toBe(
      false,
    );
    expect(isClaudeResumeSessionNotFound('HTTP 404 Not Found', 'dead-beef')).toBe(false);
    expect(isClaudeResumeSessionNotFound('authentication_failed', 'dead-beef')).toBe(false);
    expect(isClaudeResumeSessionNotFound('socket timed out', 'dead-beef')).toBe(false);
    expect(
      isClaudeResumeSessionNotFound(
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: 'The log says: No conversation found with session ID: dead-beef',
              },
            ],
          },
        },
        'dead-beef',
      ),
    ).toBe(false);
  });
});
