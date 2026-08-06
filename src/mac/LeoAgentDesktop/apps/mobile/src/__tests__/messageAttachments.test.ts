import { describe, expect, it } from 'vitest';
import { partitionMessageAttachments } from '@/session/messageAttachments';
import type { NormalizedAttachment } from '@/session/messageNormalize';

describe('partitionMessageAttachments', () => {
  it('separates images from files while preserving order within each presentation group', () => {
    const attachments: NormalizedAttachment[] = [
      { kind: 'file', name: 'brief.pdf', path: '/repo/brief.pdf', previewable: false },
      { kind: 'image', name: 'screen.png', uri: 'https://example.com/screen.png', previewable: true },
      { kind: 'file', name: 'notes.md', path: '/repo/notes.md', previewable: false },
      { kind: 'image', name: 'detail.png', uri: 'xdt-image://local/detail.png', previewable: false },
    ];

    expect(partitionMessageAttachments(attachments)).toEqual({
      imageAttachments: [
        { kind: 'image', name: 'screen.png', uri: 'https://example.com/screen.png', previewable: true },
        { kind: 'image', name: 'detail.png', uri: 'xdt-image://local/detail.png', previewable: false },
      ],
      fileAttachments: [
        { kind: 'file', name: 'brief.pdf', path: '/repo/brief.pdf', previewable: false },
        { kind: 'file', name: 'notes.md', path: '/repo/notes.md', previewable: false },
      ],
    });
  });
});
