import { describe, expect, it } from "vitest";
import {
  applyLiveNowToRunningTurnUnit,
  type ConversationTurnRenderUnit,
} from "@/v4/conversationTurnRenderUnits.js";
import { splitConversationTimelineLiveTail } from "@/v4/conversationTimelineLiveTail.js";

function unit(key: string, isRunning: boolean): ConversationTurnRenderUnit {
  return {
    key,
    turnId: key,
    visibleUserInputs: [],
    assistantWorkRows: [],
    assistantHistoryRows: [],
    assistantFollowingRows: [],
    assistantTailRows: [],
    browserTurnEndRows: [],
    hookInvocations: [],
    assistantTextRows: [],
    leadingBoundaryRows: [],
    flowItems: [],
    renderRows: [],
    isLastTurn: false,
    isRunning,
    assistantHistoryDefaultOpen: false,
    timelineOnly: false,
  };
}

describe("ConversationTimeline running live tail", () => {
  it("keeps history virtualized and splits only the latest running unit", () => {
    const history = unit("history", false);
    const live = { ...unit("live", true), isLastTurn: true };

    const result = splitConversationTimelineLiveTail([history, live]);

    expect(result.virtualizedUnits).toEqual([history]);
    expect(result.liveUnit).toBe(live);
    expect(result.liveUnitIndex).toBe(1);
  });

  it("keeps a terminal latest unit inside the virtualized history", () => {
    const history = unit("history", false);
    const terminal = { ...unit("terminal", false), isLastTurn: true };

    const result = splitConversationTimelineLiveTail([history, terminal]);

    expect(result.virtualizedUnits).toEqual([history, terminal]);
    expect(result.liveUnit).toBeNull();
    expect(result.liveUnitIndex).toBeNull();
  });

  it("does not promote a stale historical running unit", () => {
    const staleRunning = unit("stale-running", true);
    const terminal = { ...unit("terminal", false), isLastTurn: true };

    const result = splitConversationTimelineLiveTail([staleRunning, terminal]);

    expect(result.virtualizedUnits).toHaveLength(2);
    expect(result.liveUnit).toBeNull();
  });

  it("updates running work duration without mutating completed units", () => {
    const completed = unit("done", false);
    expect(applyLiveNowToRunningTurnUnit(completed, 50_000)).toBe(completed);

    const running: ConversationTurnRenderUnit = {
      ...unit("run", true),
      isLastTurn: true,
      header: {
        kind: "turnHeader",
        rowId: "h1",
        turnId: "run",
        seq: 1,
        startedAt: 10_000,
        state: "running",
      } as ConversationTurnRenderUnit["header"],
      workStatus: { state: "running" },
      workSegments: [
        {
          key: "run",
          flowItems: [],
          assistantWorkRows: [],
          assistantHistoryRows: [],
          assistantFollowingRows: [],
          assistantHistoryDefaultOpen: true,
          workStatus: { state: "running" },
        },
      ],
    };

    const ticked = applyLiveNowToRunningTurnUnit(running, 17_500);
    expect(ticked.workStatus?.durationMs).toBe(7_500);
    expect(ticked.workSegments?.[0]?.workStatus?.durationMs).toBe(7_500);
  });
});
