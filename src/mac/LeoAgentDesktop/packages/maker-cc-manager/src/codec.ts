/**
 * NDJSON line codec: parses a stream of chunks into RpcMessage[], one per line.
 *
 * Chunk boundaries do NOT align with line boundaries — we buffer the partial
 * tail across pushes. JSON.parse failures on individual lines are reported via
 * onCorruptLine (caller can log + ignore) without breaking the stream.
 *
 * UTF-8 safety (round-16 fix #1 P2): SSH / TCP chunks can split a multi-byte
 * UTF-8 character across buffer boundaries. Per-chunk `chunk.toString('utf8')`
 * decodes the partial byte sequence into U+FFFD replacement char + garbage,
 * corrupting non-ASCII content (CJK assistant text, emoji in tool args). Use
 * Node's `StringDecoder` which holds incomplete multi-byte sequences until
 * the continuation bytes arrive on the next push.
 */

import { StringDecoder } from 'node:string_decoder';

import { isRpcMessage, type RpcMessage } from './protocol.js';

export interface NDJSONDecoderOptions {
  /** Called when a non-empty line fails JSON.parse OR fails isRpcMessage check. */
  onCorruptLine?: (line: string, error: Error) => void;
}

export class NDJSONDecoder {
  /**
   * Hard cap on the unparsed buffer (chars). A stream that never sends a '\n'
   * (corrupt peer, truncated giant frame, hostile traffic) would otherwise grow
   * `buffer` without bound and OOM the desktop main process / remote daemon.
   * 64M chars comfortably exceeds any legitimate single NDJSON frame (even a
   * user message with inline base64 images is well under this), so hitting the
   * cap means the stream is junk — discard the buffer + report, don't accumulate.
   */
  private static readonly MAX_BUFFER_CHARS = 64 * 1024 * 1024;

  private buffer = '';
  /** UTF-8 boundary-aware byte→string decoder. Holds partial multi-byte
   *  sequences across push() calls. String input bypasses (already decoded). */
  private readonly decoder = new StringDecoder('utf8');
  private readonly onCorruptLine?: (line: string, error: Error) => void;

  constructor(opts: NDJSONDecoderOptions = {}) {
    this.onCorruptLine = opts.onCorruptLine;
  }

  /**
   * Feed a chunk of incoming bytes/string. Returns any complete RpcMessages
   * extracted. The trailing partial line (if any) is buffered for the next push.
   */
  push(chunk: string | Buffer): RpcMessage[] {
    // String input: caller already decoded — pass through. Buffer input: walk
    // through StringDecoder so split multi-byte codepoints are held until
    // continuation bytes arrive.
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.buffer += text;
    // OOM guard: a stream with no newline grows `buffer` unboundedly. Past the
    // hard cap, treat the accumulated bytes as junk — report once and drop them
    // so a single bad/hostile stream can't exhaust process memory. Caller's
    // onCorruptLine handler can decide to also tear down the RPC stream.
    if (this.buffer.length > NDJSONDecoder.MAX_BUFFER_CHARS) {
      const sample = this.buffer.slice(0, 256);
      this.buffer = '';
      this.onCorruptLine?.(
        sample,
        new Error(
          `NDJSON buffer exceeded ${NDJSONDecoder.MAX_BUFFER_CHARS} chars without a complete line; discarded to prevent OOM`,
        ),
      );
      return [];
    }
    if (!this.buffer.includes('\n')) {
      return [];
    }
    const lines = this.buffer.split('\n');
    // Last element is either '' (chunk ended on \n) or a partial line — buffer it.
    this.buffer = lines.pop() ?? '';
    const out: RpcMessage[] = [];
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw; // tolerate CRLF
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        this.onCorruptLine?.(line, err as Error);
        continue;
      }
      if (!isRpcMessage(parsed)) {
        this.onCorruptLine?.(line, new Error('not a valid RpcMessage shape'));
        continue;
      }
      out.push(parsed);
    }
    return out;
  }

  /**
   * Reset internal buffer. Use after socket disconnect to avoid stale partial
   * lines bleeding into a reconnect.
   */
  reset(): void {
    this.buffer = '';
    // Flush + discard any held multi-byte tail — reconnect starts a clean
    // boundary state so a stale partial sequence doesn't merge into the new
    // stream's first chunk and corrupt the first frame.
    this.decoder.end();
  }
}

/**
 * Encode an RpcMessage as a single NDJSON line (with trailing '\n').
 * Caller writes the returned string verbatim to the underlying stream.
 */
export function encodeMessage(msg: RpcMessage): string {
  return JSON.stringify(msg) + '\n';
}
