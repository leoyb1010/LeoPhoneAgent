import { useEffect, useState } from 'react';

import {
  LEO_RELEASE_NOTES,
  currentReleaseNote,
  markWhatsNewSeen,
  shouldShowWhatsNew,
} from '../releaseNotes';

/**
 * [T-release-notes] 启动时的「本次更新」。
 *
 * 极简:一个标题、一列条目、一个知道了。没有图标阵、没有插画、没有色块——
 * 用户要的是"这次改了什么",多一样装饰就多一分噪音。
 */
export function WhatsNewModal() {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (shouldShowWhatsNew()) setOpen(true);
  }, []);

  if (!open) return null;

  const note = currentReleaseNote();
  if (!note) return null;

  const close = () => {
    markWhatsNewSeen();
    setOpen(false);
  };

  const notes = showAll ? LEO_RELEASE_NOTES : [note];

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      {/*
        遮罩只做背景,不承担关闭。
        它原本是 `<button onClick={close}>`,又恰好是页面上第一个可聚焦元素 ——
        启动时任何一次自动聚焦 + 回车/空格,就会在用户看清之前把弹窗关掉,
        还顺手把这一版记成"已读",下次不再弹。铁律要求每次发版都看得见更新,
        所以关闭只能来自下面那个明确的按钮。
      */}
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div className="relative max-h-[80vh] w-full max-w-md overflow-y-auto rounded-lg border border-border bg-card p-5">
        <h2 className="text-base font-medium text-foreground">本次更新</h2>

        {notes.map((entry) => (
          <div key={entry.version} className="mt-4">
            <p className="text-xs text-muted-foreground">
              v{entry.version} · {entry.date}
            </p>
            <ul className="mt-2 space-y-2">
              {entry.items.map((item) => (
                <li key={item} className="flex gap-2 text-sm leading-relaxed text-foreground">
                  <span className="text-muted-foreground">·</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}

        <div className="mt-5 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {showAll ? '只看本次' : '查看全部更新记录'}
          </button>
          <button
            type="button"
            onClick={close}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground"
          >
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}

export default WhatsNewModal;
