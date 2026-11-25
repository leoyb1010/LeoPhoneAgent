import { useCallback, useSyncExternalStore } from "react";
import type { ConversationStoreState } from "@/v4/conversationProjectionStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";

const CLOSED_STATE: ConversationStoreState = {
  status: "closed",
  snapshot: null,
  subscriptionId: null,
  lastError: null,
  optimisticCommands: [],
  loadingOlder: false,
  sessionPlans: [],
  planDirectoryRevision: 0,
  plansLoading: false,
  turnNavigatorDirectoryRevision: 0,
};

const NOOP_UNSUBSCRIBE = () => {};
const GET_CLOSED_STATE = () => CLOSED_STATE;

/** 订阅 per-session projection store（useSyncExternalStore，row 级 selector 在组件内再做）。 */
export function useConversationProjection(lease: SessionLease | null): ConversationStoreState {
  const store = lease?.store ?? null;
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(listener) ?? NOOP_UNSUBSCRIBE,
    [store],
  );
  const getSnapshot = useCallback(() => store?.getState() ?? CLOSED_STATE, [store]);
  return useSyncExternalStore(subscribe, getSnapshot, GET_CLOSED_STATE);
}
