/**
 * xdt-helper/_history_cursor.ts —— history 类工具共享的游标编解码。
 *
 * 设计:
 *  - cursor = base64url(JSON.stringify({ createdAt: number(unix ms), id: string }))
 *  - 配合 SQL 的 `(created_at, id)` 复合排序保证分页稳定 —— 同一毫秒内多条记录
 *    用 id 兜底, 不会丢行也不会重复行
 *  - 解码失败 (用户传了垃圾字符串 / 损坏 cursor) 返 null, 由 caller 决定:
 *    list_workdirs / list_sessions 直接 fallback 到第一页;
 *    get_chat_history 同样 fallback (而不是抛 INVALID_CURSOR), 保证可恢复
 *
 * 不带签名: cursor 本身已经是不透明字符串, 用户篡改最多翻不到下一页, 不会越权。
 */

export interface HistoryCursorPayload {
  /** unix ms */
  createdAt: number;
  id: string;
  /** SQLite insertion-order tie-breaker for message history cursors. */
  rowid?: number;
}

export function encodeCursor(payload: HistoryCursorPayload): string {
  const json = JSON.stringify({
    c: payload.createdAt,
    i: payload.id,
    ...(payload.rowid !== undefined ? { r: payload.rowid } : {}),
  });
  // base64url (URL-safe, 无 padding) — Node Buffer 直接支持
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined | null): HistoryCursorPayload | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const obj = JSON.parse(json) as { c?: unknown; i?: unknown; r?: unknown };
    if (typeof obj.c !== 'number' || !Number.isFinite(obj.c)) return null;
    if (typeof obj.i !== 'string' || obj.i.length === 0) return null;
    if (obj.r !== undefined && (typeof obj.r !== 'number' || !Number.isSafeInteger(obj.r) || obj.r < 1)) {
      return null;
    }
    return {
      createdAt: obj.c,
      id: obj.i,
      ...(obj.r !== undefined ? { rowid: obj.r } : {}),
    };
  } catch {
    return null;
  }
}
