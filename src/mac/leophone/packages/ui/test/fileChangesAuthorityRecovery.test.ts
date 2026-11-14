import { describe, expect, it, vi } from "vitest";
import type {
  ConversationSnapshot,
  V4ConversationFileChangesParams,
} from "@zcode/shared/zcode-protocol-v4";
import { fetchFileChangesWithAuthorityRecovery } from "@/v4/fileChangesAuthorityRecovery.js";
const params = {
  sessionId: "s1",
  target: { rowId: 3, entityId: "turn" },
  baseRevision: 1,
  baseLogEpoch: "epoch",
} as V4ConversationFileChangesParams;
const snapshot = (revision: number, logEpoch = "epoch") =>
  ({ sessionId: "s1", revision, logEpoch }) as ConversationSnapshot;
const result = { files: 1, additions: 2, deletions: 0, items: [] };
function store(initial = snapshot(1), next = snapshot(2)) {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => ({ status: "live" as const, snapshot: current }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recoverFromStaleAuthority: vi.fn(() => {
      current = next;
      listeners.forEach((listener) => listener());
    }),
  };
}

describe("file changes authority recovery", () => {
  it("retries exactly once with the recovered authority, preserving session, epoch and target", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("proto.staleRevision"))
      .mockResolvedValue(result);
    const owner = store();
    expect(await fetchFileChangesWithAuthorityRecovery(query, params, owner as never)).toEqual(
      result,
    );
    expect(owner.recoverFromStaleAuthority).toHaveBeenCalledOnce();
    expect(query).toHaveBeenLastCalledWith({ ...params, baseRevision: 2 });
  });
  it("does not retry in a different log epoch or retry ordinary failures", async () => {
    const query = vi.fn().mockRejectedValue(new Error("proto.staleRevision"));
    await expect(
      fetchFileChangesWithAuthorityRecovery(
        query,
        params,
        store(snapshot(1), snapshot(2, "other")) as never,
      ),
    ).rejects.toThrow("proto.staleRevision");
    expect(query).toHaveBeenCalledOnce();
    const failure = vi.fn().mockRejectedValue(new Error("file unavailable"));
    const owner = store();
    await expect(
      fetchFileChangesWithAuthorityRecovery(failure, params, owner as never),
    ).rejects.toThrow("file unavailable");
    expect(owner.recoverFromStaleAuthority).not.toHaveBeenCalled();
  });
  it("uses an already newer store authority without adding a recovery or a retry loop", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("proto.staleRevision"))
      .mockResolvedValue(result);
    const owner = store(snapshot(3));
    await fetchFileChangesWithAuthorityRecovery(query, params, owner as never);
    expect(owner.recoverFromStaleAuthority).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
  });
});
