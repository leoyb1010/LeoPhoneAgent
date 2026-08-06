/**
 * 全窗拖入拦截的跨组件契约(GlobalDropImportListener ↔ 各内层 drop 区)。
 *
 * .cindy(意识安装包)/ .cshare(会话分享,含旧 .xdtshare)拖入主窗口时,
 * 无论落在哪个区域都应走全局装入 / 导入链路,而不是被 composer / 文件浏览器
 * 等内层 drop 区当普通附件消费。GlobalDropImportListener 在 window capture
 * 阶段先于内层 handler 收到 drop,按扩展名同步判定(零 IO)后:
 *   - preventDefault + markGlobalDropIntercepted(e) 标记本事件已被全局接管;
 *   - 不 stopPropagation —— 事件照常传到内层,内层 handler 用
 *     isGlobalDropIntercepted(e.nativeEvent) 识别后只清理自己的拖拽 UI 状态
 *     (计数器 / 遮罩),跳过附件消费。
 * 之所以用"标记 + 内层自查"而非 capture stopPropagation:MIME 未注册的机器
 * (dev / 旧版升级前)悬停阶段识别不到文件类型,内层遮罩已经亮起,若 drop
 * 被静默吞掉,内层的 dragCounter 永不归零、遮罩卡死。
 */
import { CINDY_FILE_EXT, SHARE_FILE_EXTS } from '../../shared/fileTypes';

export type GlobalDropKind = 'cindy' | 'share';

/**
 * 按扩展名判定拖入路径是否该被全局接管(意识入口已全量放开,不再看灰度)。
 */
export function classifyGlobalDropPath(path: string): GlobalDropKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(CINDY_FILE_EXT)) return 'cindy';
  if (SHARE_FILE_EXTS.some((ext) => lower.endsWith(ext))) return 'share';
  return null;
}

// WeakSet 标记:drop 事件对象在 capture → target → bubble 全程是同一个实例
// (React 合成事件经 nativeEvent 取回),事件结束后自动可回收。
const interceptedDrops = new WeakSet<Event>();

/** GlobalDropImportListener 专用:标记该 drop 事件已被全局接管。 */
export function markGlobalDropIntercepted(e: Event): void {
  interceptedDrops.add(e);
}

/** 内层 drop 区自查:true 表示全局已接管,只需清理自身拖拽 UI 状态后 return。 */
export function isGlobalDropIntercepted(e: Event): boolean {
  return interceptedDrops.has(e);
}
