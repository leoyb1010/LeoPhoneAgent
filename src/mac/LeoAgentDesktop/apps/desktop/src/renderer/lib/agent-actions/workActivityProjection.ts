/** Desktop type adapter for the framework-agnostic shared activity projection. */
import {
  projectRecentWorkActivities as projectRecentSharedWorkActivities,
  projectWorkActivities as projectSharedWorkActivities,
  type ExplorationActivity,
  type ExplorationActivityKind,
  type ProjectableWorkChild,
  type ProjectedThinkingActivity,
  type ProjectedToolActivity as SharedProjectedToolActivity,
  type ProjectedWorkActivity as SharedProjectedWorkActivity,
  type WorkActivityProjection as SharedWorkActivityProjection,
} from '@cindy/maker-shared/work-activity-projection';

import type { ChatMessage } from '@/lib/makerChatStore';

export type { ExplorationActivity, ExplorationActivityKind, ProjectedThinkingActivity };
export type ProjectedToolActivity = SharedProjectedToolActivity<ChatMessage>;
export type ProjectedWorkActivity = SharedProjectedWorkActivity<ChatMessage>;
export type WorkActivityProjection = SharedWorkActivityProjection<ChatMessage>;

export function projectRecentWorkActivities(
  childItems: readonly ProjectableWorkChild<ChatMessage>[],
  isStreaming: boolean,
  limit: number,
): ProjectedWorkActivity[] {
  return projectRecentSharedWorkActivities(childItems, isStreaming, limit);
}

export function projectWorkActivities(
  childItems: readonly ProjectableWorkChild<ChatMessage>[],
  isStreaming: boolean,
): WorkActivityProjection {
  return projectSharedWorkActivities(childItems, isStreaming);
}
