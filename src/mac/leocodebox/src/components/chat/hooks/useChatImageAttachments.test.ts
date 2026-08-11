import assert from 'node:assert/strict';
import test from 'node:test';

import { validateImageAttachment } from './useChatImageAttachments';

test('accepts non-empty image files within the attachment limit', () => {
  const file = new File(['image'], 'photo.png', { type: 'image/png' });
  assert.deepEqual(validateImageAttachment(file), { valid: true });
});

test('rejects non-image, empty, and oversized attachments', () => {
  const text = new File(['hello'], 'notes.txt', { type: 'text/plain' });
  const empty = new File([], 'empty.png', { type: 'image/png' });
  const oversized = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' });

  assert.deepEqual(validateImageAttachment(text), { valid: false });
  assert.deepEqual(validateImageAttachment(empty), {
    valid: false,
    error: 'File too large (max 5MB)',
  });
  assert.deepEqual(validateImageAttachment(oversized), {
    valid: false,
    error: 'File too large (max 5MB)',
  });
});
