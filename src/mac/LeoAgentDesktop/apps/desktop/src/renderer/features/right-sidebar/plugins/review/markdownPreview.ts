import { isReviewMarkdownPath } from '../../../../../shared/reviewMarkdownExts';
import type { FileDiff } from '@/lib/gitReview.types';

export type RichMarkdownPreviewBlockReason =
  | 'disabled'
  | 'not-markdown'
  | 'deleted'
  | 'unsupported-kind'
  | 'too-large';

export interface RichMarkdownPreviewEligibility {
  canPreview: boolean;
  reason: RichMarkdownPreviewBlockReason | null;
}

export function getRichMarkdownPreviewEligibility(
  diff: Pick<FileDiff, 'kind' | 'path' | 'status' | 'isBinary' | 'isTooLarge'>,
  enabled: boolean,
): RichMarkdownPreviewEligibility {
  if (!enabled) return { canPreview: false, reason: 'disabled' };
  if (!isReviewMarkdownPath(diff.path)) return { canPreview: false, reason: 'not-markdown' };
  if (diff.status === 'deleted') return { canPreview: false, reason: 'deleted' };
  if (diff.kind === 'large-text' || diff.kind === 'too-large' || diff.isTooLarge) {
    return { canPreview: false, reason: 'too-large' };
  }
  if (diff.kind !== 'text' || diff.isBinary) return { canPreview: false, reason: 'unsupported-kind' };
  return { canPreview: true, reason: null };
}
