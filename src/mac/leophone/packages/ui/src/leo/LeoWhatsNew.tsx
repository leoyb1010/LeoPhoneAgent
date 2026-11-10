import { ZCODE_VERSION } from "@zcode/shared";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { LeoMark } from "./LeoMark.js";
import { markLeoWhatsNewSeen, unseenLeoReleases, type LeoRelease } from "./leoReleaseNotes.js";
// 皮肤层随「本次更新」一起加载:两者都挂在 Root,模块求值早于首屏。
import "./skin/leoSkin.js";

/** 更新说明复用共享 Dialog 的焦点约束；只有明确确认或 Escape 才记为已读。 */
export function LeoWhatsNew() {
  const { intl } = useZCodeIntl();
  const [notes, setNotes] = useState<LeoRelease[]>([]);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setNotes(unseenLeoReleases(ZCODE_VERSION));
  }, []);

  const [latest] = notes;
  if (!latest) return null;

  const close = () => {
    markLeoWhatsNewSeen(ZCODE_VERSION);
    setNotes([]);
  };

  return (
    <Dialog open onOpenChange={(nextOpen) => { if (!nextOpen) close(); }}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[80vh] sm:max-w-md flex-col gap-0 overflow-hidden p-0 motion-reduce:animate-none! motion-reduce:duration-0!"
        overlayClassName="motion-reduce:animate-none! motion-reduce:duration-0!"
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          // 聚焦顶部标题而不是底部按钮，长列表不被自动滚到底，也不因回车误记已读。
          event.preventDefault();
          titleRef.current?.focus({ preventScroll: true });
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocusRef.current?.isConnected) {
            event.preventDefault();
            returnFocusRef.current.focus({ preventScroll: true });
          }
        }}
      >
        <div className="flex shrink-0 items-center gap-3 px-6 pt-6 pb-4">
          <LeoMark className="h-7 w-7 shrink-0" />
          <div className="min-w-0">
            <DialogTitle ref={titleRef} tabIndex={-1} className="text-ui-lg leading-tight outline-none">
              {intl.formatMessage({ id: "leoWhatsNew.title" })}
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-ui-caption text-foreground tabular-nums">
              v{latest.version} · {latest.date}
            </DialogDescription>
          </div>
        </div>
        <div className="min-h-0 overflow-y-auto px-6">
          {notes.map((note, index) => (
            <section key={note.version} className={index > 0 ? "mt-5" : undefined}>
              {index > 0 ? (
                <h3 className="mb-2 text-ui-caption text-foreground tabular-nums">
                  v{note.version} · {note.date}
                </h3>
              ) : null}
              <ul className="space-y-2.5">
                {note.items.map((item) => (
                  <li key={item} className="flex gap-2.5 text-ui-base leading-relaxed">
                    <span aria-hidden="true" className="mt-[0.6em] size-1 shrink-0 rounded-full bg-foreground" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="flex shrink-0 justify-end px-6 py-5">
          <Button type="button" variant="secondary" className="min-h-10 px-4" onClick={close}>
            {intl.formatMessage({ id: "leoWhatsNew.confirm" })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
