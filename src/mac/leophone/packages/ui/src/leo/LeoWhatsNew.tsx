import { ZCODE_VERSION } from "@zcode/shared";
import { useEffect, useRef, useState } from "react";

import { LeoMark } from "./LeoMark.js";
import { markLeoWhatsNewSeen, unseenLeoReleases, type LeoRelease } from "./leoReleaseNotes.js";
// 皮肤层随「本次更新」一起加载:两者都挂在 Root,模块求值早于首屏。
import "./skin/leoSkin.js";

/**
 * [leo][T-release-notes] 启动时的「本次更新」。
 *
 * 一个标题、一列条目、一个「知道了」。遮罩不承担关闭:它是页面上第一个可聚焦
 * 元素时,启动时的自动聚焦 + 回车会在用户看清之前把卡关掉,还顺手记成已读。
 */
export function LeoWhatsNew() {
  const [notes, setNotes] = useState<LeoRelease[]>([]);
  const open = notes.length > 0;
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setNotes(unseenLeoReleases(ZCODE_VERSION));
  }, []);

  // 焦点放在「知道了」上,但不能滚动:条目多时 autoFocus 会把卡片直接滚到底,标题和前几条一打开就看不见。
  useEffect(() => {
    if (open) confirmRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      markLeoWhatsNewSeen(ZCODE_VERSION);
      setNotes([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const [latest] = notes;
  if (!latest) return null;

  const close = () => {
    markLeoWhatsNewSeen(ZCODE_VERSION);
    setNotes([]);
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="leo-whats-new-scrim fixed inset-0 bg-black/45" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="本次更新"
        className="leo-whats-new-card relative max-h-[80vh] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-popover px-6 pb-5 pt-6 text-foreground"
      >
        <div className="flex items-center gap-3">
          <LeoMark className="h-7 w-7 shrink-0" />
          <div className="min-w-0">
            <h2 className="text-ui-lg font-medium leading-tight">本次更新</h2>
            <p className="mt-0.5 text-ui-caption text-foreground-subtle tabular-nums">
              v{latest.version} · {latest.date}
            </p>
          </div>
        </div>
        {notes.map((note, index) => (
          <section key={note.version} className="mt-5">
            {index > 0 ? (
              <h3 className="mb-2 text-ui-caption text-foreground-subtle tabular-nums">
                v{note.version} · {note.date}
              </h3>
            ) : null}
            <ul className="space-y-2.5">
              {note.items.map((item) => (
                <li key={item} className="flex gap-2.5 text-ui-base leading-relaxed">
                  <span
                    aria-hidden="true"
                    className="mt-[0.6em] size-1 shrink-0 rounded-full bg-brand"
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <div className="mt-6 flex justify-end">
          <button
            ref={confirmRef}
            type="button"
            onClick={close}
            className="rounded-lg bg-brand px-4 py-1.5 text-ui-base font-medium text-foreground-inverse transition-[filter] duration-150 hover:brightness-110 focus-visible:outline-2! focus-visible:outline-offset-2! focus-visible:outline-brand!"
          >
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
