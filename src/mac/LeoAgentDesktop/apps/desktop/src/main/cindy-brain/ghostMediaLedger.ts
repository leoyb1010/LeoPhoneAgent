/**
 * ghostMediaLedger —— ghost_call 期间入库媒体的进程内账本(规则 9 兜底层)。
 *
 * 背景(2026-07-16 实踩):意识可以在工具结果里删掉 xdt_image_urls(mivo
 * 画卡防双渲染),导致 IM/hook 出站拿不到任何媒体地址,生成图永远到不了
 * Slack/飞书用户手里。意识产生的每一份媒体都必经主机之手落 cindy-media
 * 总仓(networkSlot as:'media' 下载 / cindySlot 模型代办生成),所以主机
 * 按 ghostId+callId 记账,调用收口时把账本随结果带回(producedMedia),
 * ghost_call 层在意识未声明媒体字段时注入 xdt_media_produced —— 意识代码
 * 删不掉这份主机侧事实。
 *
 * 记账原则:
 * - 只记**署名调用**(callId 非空)。未署名(意识 fetch 没带 callId)不记,
 *   避免并发调用间误配 —— 署名是意识作者换取"产物自动送达 IM"的对价,
 *   FORGE_GUIDE 写明。
 * - drain 即删;异常路径没 drain 的条目按 STALE_MS 惰性清扫,防泄漏。
 */

const MAX_URLS_PER_CALL = 32;
const MAX_KEYS = 512;
const STALE_MS = 10 * 60_000;

interface LedgerEntry {
  urls: string[];
  at: number;
}

const pending = new Map<string, LedgerEntry>();

function keyOf(ghostId: string, callId: string): string {
  return `${ghostId}\n${callId}`;
}

function sweep(now: number): void {
  for (const [k, e] of pending) {
    if (now - e.at > STALE_MS) pending.delete(k);
  }
}

/** 记一笔:某意识在某次工具调用期间入库了一份媒体(url = cindy-media://)。 */
export function recordGhostCallMedia(
  ghostId: string,
  callId: string | undefined,
  url: string,
): void {
  if (!callId || !ghostId || !url) return;
  const now = Date.now();
  sweep(now);
  const k = keyOf(ghostId, callId);
  let entry = pending.get(k);
  if (!entry) {
    if (pending.size >= MAX_KEYS) return;
    entry = { urls: [], at: now };
    pending.set(k, entry);
  }
  entry.at = now;
  if (entry.urls.length < MAX_URLS_PER_CALL && !entry.urls.includes(url)) {
    entry.urls.push(url);
  }
}

/** 收口取账(取出即删)。没有账返回空数组。 */
export function drainGhostCallMedia(ghostId: string, callId: string): string[] {
  const k = keyOf(ghostId, callId);
  const entry = pending.get(k);
  if (!entry) return [];
  pending.delete(k);
  return entry.urls;
}

/** 仅测试用:清空账本。 */
export function _resetGhostMediaLedgerForTest(): void {
  pending.clear();
}
