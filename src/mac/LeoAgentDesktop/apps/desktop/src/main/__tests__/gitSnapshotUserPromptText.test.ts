import { describe, expect, it } from 'vitest';

import { extractUserPromptText } from '../git-snapshot/userPromptText';

describe('extractUserPromptText', () => {
  it('returns JSON string content', () => {
    expect(extractUserPromptText(JSON.stringify('plain request'))).toBe('plain request');
  });

  it('joins text blocks from multimodal content', () => {
    expect(extractUserPromptText(JSON.stringify([
      { type: 'text', text: 'first' },
      { type: 'image', url: 'xdt-image://1' },
      { type: 'text', text: 'second' },
    ]))).toBe('first second');
  });

  it('uses object text content when available', () => {
    expect(extractUserPromptText(JSON.stringify({ text: 'object text' }))).toBe('object text');
  });

  it('falls back to raw content for plain text', () => {
    expect(extractUserPromptText('raw prompt')).toBe('raw prompt');
  });
});
