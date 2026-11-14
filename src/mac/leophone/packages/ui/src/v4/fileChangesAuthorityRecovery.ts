import type {
  ConversationSnapshot,
  V4ConversationFileChangesParams,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationProjectionStore } from "./conversationProjectionStore.js";

type RecoveryStore = Pick<
  ConversationProjectionStore,
  "getState" | "subscribe" | "recoverFromStaleAuthority"
>;

function recoverAuthority(store: RecoveryStore): Promise<ConversationSnapshot> {
  const previous = store.getState().snapshot;
  return new Promise((resolve, reject) => {
    let finished = false;
    let unsubscribe = () => {};
    const check = () => {
      const state = store.getState();
      if (finished) return;
      if (state.status === "error" || state.status === "closed") {
        finished = true;
        unsubscribe();
        reject(new Error(state.lastError ?? "conversation unavailable"));
      } else if (state.status === "live" && state.snapshot && state.snapshot !== previous) {
        finished = true;
        unsubscribe();
        resolve(state.snapshot);
      }
    };
    unsubscribe = store.subscribe(check);
    store.recoverFromStaleAuthority();
    check();
  });
}

/** 只读详情遇到晚到revision时，等待现有恢复链一次，再用同会话/同epoch的新权威重试。
 * 不放宽服务端CAS，不修改row target，也不让每个token触发整段对话重渲染。 */
export async function fetchFileChangesWithAuthorityRecovery(
  query: (params: V4ConversationFileChangesParams) => Promise<V4ConversationFileChangesResult>,
  params: V4ConversationFileChangesParams,
  store: RecoveryStore | undefined,
): Promise<V4ConversationFileChangesResult> {
  try {
    return await query(params);
  } catch (error) {
    if (!store || !(error instanceof Error) || error.message !== "proto.staleRevision") throw error;
    const state = store.getState();
    if (state.status === "closed" || state.status === "error") throw error;
    let fresh = state.snapshot;
    if (
      !fresh ||
      (fresh.revision === params.baseRevision && fresh.logEpoch === params.baseLogEpoch)
    )
      fresh = await recoverAuthority(store);
    if (fresh.sessionId !== params.sessionId || fresh.logEpoch !== params.baseLogEpoch) throw error;
    return query({ ...params, baseRevision: fresh.revision });
  }
}
