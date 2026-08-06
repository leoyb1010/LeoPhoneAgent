/**
 * git-review main types.
 *
 * IPC DTOs are shared with preload/renderer via shared/gitReviewWire. This
 * file only adds main-only dependency wiring.
 */

export type * from '../../shared/gitReviewWire.js';

import type {
  ReviewData,
  ReviewDiffReadOptions,
  ReviewScope,
  ReviewStatus,
} from '../../shared/gitReviewWire.js';

export interface GitReviewDeps {
  resolveScope: (sessionId: string) => Promise<ReviewScope>;
  readStatus: (scope: ReviewScope) => Promise<ReviewStatus>;
  readDiffs: (scope: ReviewScope, status: ReviewStatus, options?: ReviewDiffReadOptions) => Promise<ReviewData['diffs']>;
  isSessionRunning?: (sessionId: string) => boolean | Promise<boolean>;
}
