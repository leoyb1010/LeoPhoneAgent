/**
 * useDelayedFlag —— 延迟门控的 loading 标记。
 *
 * `active` 持续超过 `delayMs` 才返回 true;`active` 变 false 立即复位。
 *
 * 用途:文件浏览的 loading 态展示。设计规范(DESIGN.md)约定本地数据
 * 不做 loading UI——本地 IPC 往返 <30ms,永远到不了阈值,界面零变化,规则
 * 继续成立;SSH / device-link 慢通道超过阈值后 spinner 自然浮现,避免长空白
 * 被读成"坏了"。渲染层因此不需要按 transport 分支,对来源保持无感。
 */
import { useEffect, useState } from 'react';

export function useDelayedFlag(active: boolean, delayMs = 300): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    const timer = window.setTimeout(() => setOn(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return on;
}
