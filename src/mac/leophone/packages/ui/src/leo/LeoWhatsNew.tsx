import { ZCODE_VERSION } from "@zcode/shared";
import { useEffect, useState } from "react";

import {
  currentLeoRelease,
  markLeoWhatsNewSeen,
  shouldShowLeoWhatsNew,
} from "./leoReleaseNotes.js";

/**
 * [leo][T-release-notes] 启动时的「本次更新」。
 *
 * 一个标题、一列条目、一个「知道了」。遮罩不承担关闭:它是页面上第一个可聚焦
 * 元素时,启动时的自动聚焦 + 回车会在用户看清之前把卡关掉,还顺手记成已读。
 */
export function LeoWhatsNew() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (shouldShowLeoWhatsNew(ZCODE_VERSION)) setOpen(true);
  }, []);

  if (!open) return null;
  const note = currentLeoRelease(ZCODE_VERSION);
  if (!note) return null;

  const close = () => {
    markLeoWhatsNewSeen(ZCODE_VERSION);
    setOpen(false);
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="本次更新"
        className="relative max-h-[80vh] w-full max-w-md overflow-y-auto rounded-lg border border-border bg-popover p-5 text-foreground shadow-lg"
      >
        <h2 className="text-ui-lg font-medium">本次更新</h2>
        <p className="mt-1 text-ui-caption text-foreground-subtle">
          v{note.version} · {note.date}
        </p>
        <ul className="mt-3 space-y-2">
          {note.items.map((item) => (
            <li key={item} className="flex gap-2 text-ui-base leading-relaxed">
              <span className="text-foreground-subtle">·</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            autoFocus
            onClick={close}
            className="rounded-md bg-brand px-4 py-1.5 text-ui-base font-medium text-foreground-inverse"
          >
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
