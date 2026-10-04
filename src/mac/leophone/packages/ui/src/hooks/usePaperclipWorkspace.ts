import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { IPaperclipWorkspace } from "@zcode/services";

export function usePaperclipWorkspace(service: IPaperclipWorkspace) {
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const [localError, setLocalError] = useState<string | null>(null);
  const invoke = useCallback(
    async (action: () => Promise<void>): Promise<boolean> => {
      const generation = service.getSnapshot().generation;
      setLocalError(null);
      try {
        await action();
        return true;
      } catch (error) {
        if (generation === service.getSnapshot().generation && !service.getSnapshot().error) {
          setLocalError(error instanceof Error ? error.message : "服务器操作失败。");
        }
        return false;
      }
    },
    [service],
  );
  useEffect(() => {
    void invoke(() => service.initialize());
  }, [invoke, service]);
  useEffect(() => {
    setLocalError(null);
  }, [snapshot.generation]);
  useEffect(() => {
    const timer = setInterval(() => {
      const current = service.getSnapshot();
      if (
        current.user &&
        current.companyId &&
        !current.busy &&
        document.visibilityState === "visible"
      ) {
        void invoke(() => service.refresh());
      }
    }, 15000);
    return () => clearInterval(timer);
  }, [invoke, service]);
  return { snapshot, invoke, error: snapshot.error ?? localError };
}
