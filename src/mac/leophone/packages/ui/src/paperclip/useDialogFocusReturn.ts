import { useRef } from "react";

/** 受控 Dialog 没有 Radix Trigger；焦点属于当前窗口 UI，不属于任务服务。 */
export function useDialogFocusReturn(fallback: string) {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    },
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      const current = opener.current;
      const target =
        current?.isConnected && current.getClientRects().length > 0
          ? current
          : Array.from(document.querySelectorAll<HTMLElement>(fallback)).find(
              (element) => element.getClientRects().length > 0,
            );
      target?.focus();
    },
  };
}
