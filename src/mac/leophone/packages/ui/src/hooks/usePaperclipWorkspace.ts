import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  PaperclipWorkspaceService,
  type PaperclipPersistence,
  type PaperclipTransport,
} from "@zcode/services/paperclip";

/** 组件只订阅快照；网络、身份和操作回执的唯一所有者是 service。 */
export function usePaperclipWorkspace(
  transport: PaperclipTransport,
  persistence: PaperclipPersistence,
) {
  const service = useMemo(
    () => new PaperclipWorkspaceService(transport, persistence),
    [transport, persistence],
  );
  const snapshot = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot,
  );
  useEffect(() => {
    void service.refresh();
    const timer = setInterval(() => {
      const state = service.getSnapshot();
      if (!state.busy && ["online", "offline"].includes(state.connection)) void service.refresh();
    }, 15000);
    return () => clearInterval(timer);
  }, [service]);
  return { snapshot, service };
}
