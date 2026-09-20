import { useEffect, useRef, useState } from 'react';

import { LEO_RELEASE_NOTES, type LeoReleaseNote } from '../components/version-upgrade/releaseNotes';

/**
 * 2.0 壳里的「本次更新」。遮罩只做背景,只有「知道了」能关并记账。
 * 样式跟命令面板同一套令牌,不走旧的 Tailwind 卡片。
 */
export function WhatsNewOverlay({
  note,
  onDismiss,
}: {
  note: LeoReleaseNote;
  onDismiss: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const dismissRef = useRef<HTMLButtonElement | null>(null);
  const notes = showAll ? LEO_RELEASE_NOTES : [note];

  useEffect(() => { dismissRef.current?.focus(); }, []);

  return (
    <div className="wn" role="dialog" aria-modal="true" aria-label="本次更新">
      <div className="wn-mask" aria-hidden="true" />
      <div className="wn-box">
        <h2>本次更新</h2>
        {notes.map((entry) => (
          <div className="wn-entry" key={entry.version}>
            <p className="wn-ver">v{entry.version}{entry.date ? ` · ${entry.date}` : ''}</p>
            <ul>
              {entry.items.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
        ))}
        <div className="wn-acts">
          <button className="link" type="button" onClick={() => setShowAll((v) => !v)}>{showAll ? '只看本次' : '查看全部更新记录'}</button>
          <button ref={dismissRef} className="btn-s" type="button" onClick={onDismiss}>知道了</button>
        </div>
      </div>
    </div>
  );
}
