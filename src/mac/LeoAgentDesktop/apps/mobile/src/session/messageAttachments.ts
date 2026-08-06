import type { NormalizedAttachment } from '@/session/messageNormalize';

export interface PartitionedMessageAttachments {
  imageAttachments: NormalizedAttachment[];
  fileAttachments: NormalizedAttachment[];
}

/**
 * Keeps desktop message attachment order stable inside each mobile presentation group.
 */
export function partitionMessageAttachments(
  attachments: readonly NormalizedAttachment[],
): PartitionedMessageAttachments {
  const imageAttachments: NormalizedAttachment[] = [];
  const fileAttachments: NormalizedAttachment[] = [];

  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      imageAttachments.push(attachment);
    } else {
      fileAttachments.push(attachment);
    }
  }

  return { imageAttachments, fileAttachments };
}
