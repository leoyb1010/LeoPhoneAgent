/**
 * Request-time context compaction for the Leoapi gateway (opt-in, default-off).
 *
 * pi's "compaction" idea applied at the one place we own every request: when an
 * Anthropic /v1/messages body carries a long history, we trim the OLDEST,
 * oversized tool_result blocks — the usual bloat — before forwarding upstream,
 * cutting input tokens (cost) with zero added latency (no model call).
 *
 * Correctness-first invariants (why this is safe enough to expose as beta):
 *   - the system prompt is never touched;
 *   - the FIRST turn (task setup) is kept verbatim;
 *   - the last KEEP_RECENT turns are kept verbatim;
 *   - only `tool_result` block bodies are trimmed (never text / tool_use);
 *   - only when the body is clearly long (> MIN_MESSAGES) — otherwise no-op;
 *   - any unexpected shape / parse failure returns the input UNCHANGED.
 * It is lossy by construction, hence opt-in and off by default.
 */

const KEEP_FIRST = 1; // first turn (task framing) always kept verbatim
const KEEP_RECENT = 20; // last N turns always kept verbatim
// Below this, never act. It must clear the quantized boundary below, otherwise
// the boundary rounds down to zero and compaction is a silent no-op anyway.
const MIN_MESSAGES = KEEP_FIRST + KEEP_RECENT + 20;
const MAX_OLD_TOOL_RESULT = 2000; // chars kept from an old tool_result before trimming
/** The trim boundary only advances in blocks of this many messages, so the
 *  compacted prefix stays byte-identical (and prompt-cacheable) between turns. */
const BOUNDARY_STEP = 20;

export type CompactionStats = { touchedBlocks: number; savedChars: number };
type Block = Record<string, unknown>;
type Message = { role?: unknown; content?: unknown };
type MessagesBody = { system?: unknown; messages?: unknown; [key: string]: unknown };

function marker(saved: number): string {
  return `\n\n[leocodebox 已裁剪约 ${saved} 字符的历史工具输出以降本;系统提示、首轮与近 ${KEEP_RECENT} 轮完整保留]`;
}

/** Trim one string beyond the cap; returns the (possibly) shortened text + chars saved. */
function trimText(text: string): { text: string; saved: number } {
  if (text.length <= MAX_OLD_TOOL_RESULT) return { text, saved: 0 };
  const kept = text.slice(0, MAX_OLD_TOOL_RESULT);
  const saved = text.length - kept.length;
  return { text: `${kept}${marker(saved)}`, saved };
}

/** Compact a single tool_result block's content in place-free fashion (returns a new block). */
function compactToolResult(block: Block, stats: CompactionStats): Block {
  const content = block.content;
  if (typeof content === 'string') {
    const { text, saved } = trimText(content);
    if (saved === 0) return block;
    stats.touchedBlocks += 1;
    stats.savedChars += saved;
    return { ...block, content: text };
  }
  if (Array.isArray(content)) {
    let changed = false;
    const nextContent = content.map((part) => {
      if (part && typeof part === 'object' && (part as Block).type === 'text' && typeof (part as Block).text === 'string') {
        const { text, saved } = trimText((part as Block).text as string);
        if (saved === 0) return part;
        changed = true;
        stats.touchedBlocks += 1;
        stats.savedChars += saved;
        return { ...(part as Block), text };
      }
      return part;
    });
    return changed ? { ...block, content: nextContent } : block;
  }
  return block;
}

/** Compact one message's content array (only tool_result blocks are eligible). */
function compactMessage(message: Message, stats: CompactionStats): Message {
  if (!Array.isArray(message.content)) return message;
  let changed = false;
  const nextContent = (message.content as unknown[]).map((block) => {
    if (block && typeof block === 'object' && (block as Block).type === 'tool_result') {
      const next = compactToolResult(block as Block, stats);
      if (next !== block) changed = true;
      return next;
    }
    return block;
  });
  return changed ? { ...message, content: nextContent } : message;
}

/**
 * Pure core: compact a parsed /v1/messages body. Returns a NEW body (input is
 * never mutated) plus stats. No-op (returns input, zero stats) unless the
 * history is clearly long and something was actually trimmed.
 */
export function compactMessages(body: MessagesBody): { body: MessagesBody; stats: CompactionStats } {
  const stats: CompactionStats = { touchedBlocks: 0, savedChars: 0 };
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length < MIN_MESSAGES) return { body, stats };

  // Quantize the boundary so it does NOT advance every turn. A per-turn
  // boundary rewrote a message that the previous request had sent verbatim,
  // which changes the prompt prefix and invalidates the client's prompt cache
  // on essentially every request — re-billing the whole history as cache writes
  // and making a cost-saving feature cost MORE on exactly the long
  // conversations it targets. Moving in blocks keeps the compacted prefix
  // byte-identical across a run of turns.
  const lastMiddle = Math.floor((messages.length - KEEP_RECENT) / BOUNDARY_STEP) * BOUNDARY_STEP;
  if (lastMiddle <= KEEP_FIRST) return { body, stats };
  const next = messages.map((message, index) => {
    if (index < KEEP_FIRST || index >= lastMiddle) return message; // keep first + recent verbatim
    return compactMessage(message as Message, stats);
  });
  if (stats.touchedBlocks === 0) return { body, stats };
  return { body: { ...body, messages: next }, stats };
}

/** Route wrapper: parse a raw JSON body, compact it, re-serialize. Returns null (use original) on any issue. */
export function compactRequestBody(raw: Buffer): { body: Buffer; stats: CompactionStats } | null {
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as MessagesBody;
    const { body, stats } = compactMessages(parsed);
    if (stats.touchedBlocks === 0) return null;
    return { body: Buffer.from(JSON.stringify(body), 'utf8'), stats };
  } catch {
    return null; // fail open: never corrupt a request we can't confidently rewrite
  }
}

// ---- running savings counter (surfaced on the dashboard) --------------------
let totalRequests = 0;
let totalTouched = 0;
let totalSaved = 0;

export function recordCompaction(stats: CompactionStats): void {
  totalRequests += 1;
  totalTouched += stats.touchedBlocks;
  totalSaved += stats.savedChars;
}

export function compactionSnapshot(): { requests: number; touchedBlocks: number; savedChars: number } {
  return { requests: totalRequests, touchedBlocks: totalTouched, savedChars: totalSaved };
}

/** Test-only reset. */
export function __resetCompaction(): void {
  totalRequests = 0;
  totalTouched = 0;
  totalSaved = 0;
}
