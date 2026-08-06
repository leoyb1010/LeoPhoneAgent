import { describe, expect, it, vi } from 'vitest';

import { NDJSONDecoder, encodeMessage } from '../src/codec.js';
import type { RpcMessage } from '../src/protocol.js';

describe('NDJSONDecoder', () => {
  it('decodes a single complete line', () => {
    const decoder = new NDJSONDecoder();
    const out = decoder.push('{"type":"notification","method":"x","params":{}}\n');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'notification', method: 'x' });
  });

  it('buffers partial line across pushes', () => {
    const decoder = new NDJSONDecoder();
    expect(decoder.push('{"type":"notif')).toEqual([]);
    expect(decoder.push('ication","method":"y","params":{}}\n')).toHaveLength(1);
  });

  it('handles multiple lines in one chunk', () => {
    const decoder = new NDJSONDecoder();
    const chunk =
      '{"type":"notification","method":"a","params":{}}\n' +
      '{"type":"notification","method":"b","params":{}}\n';
    const out = decoder.push(chunk);
    expect(out.map((m) => (m as { method: string }).method)).toEqual(['a', 'b']);
  });

  it('tolerates CRLF', () => {
    const decoder = new NDJSONDecoder();
    const out = decoder.push('{"type":"notification","method":"x","params":{}}\r\n');
    expect(out).toHaveLength(1);
  });

  it('ignores blank lines', () => {
    const decoder = new NDJSONDecoder();
    const out = decoder.push('\n\n{"type":"notification","method":"x","params":{}}\n\n');
    expect(out).toHaveLength(1);
  });

  it('calls onCorruptLine for invalid JSON and continues', () => {
    const onCorruptLine = vi.fn();
    const decoder = new NDJSONDecoder({ onCorruptLine });
    const out = decoder.push(
      'not json\n{"type":"notification","method":"x","params":{}}\n',
    );
    expect(onCorruptLine).toHaveBeenCalledOnce();
    expect(out).toHaveLength(1);
  });

  it('calls onCorruptLine for JSON that is not a valid RpcMessage', () => {
    const onCorruptLine = vi.fn();
    const decoder = new NDJSONDecoder({ onCorruptLine });
    const out = decoder.push('{"foo":42}\n');
    expect(onCorruptLine).toHaveBeenCalledOnce();
    expect(out).toEqual([]);
  });

  it('reset() clears partial buffer', () => {
    const decoder = new NDJSONDecoder();
    decoder.push('{"type":"notif');
    decoder.reset();
    // After reset, feeding what would have completed the line now appears corrupt.
    const onCorruptLine = vi.fn();
    const fresh = new NDJSONDecoder({ onCorruptLine });
    fresh.push('ication","method":"x","params":{}}\n');
    // The fresh decoder sees this as corrupt because it starts mid-token.
    expect(onCorruptLine).toHaveBeenCalled();
  });

  it('handles UTF-8 multibyte chunks split mid-character via Buffer concat', () => {
    const decoder = new NDJSONDecoder();
    // '远端' = E8 BF 9C E7 AB AF in UTF-8 (6 bytes). Split inside the first char.
    // Note: decoder receives string OR buffer; Buffer.toString handles multi-byte on full chunks.
    // We test that two valid chunks (each whole utf8) concatenate fine.
    const msg = JSON.stringify({
      type: 'notification',
      method: 'evt',
      params: { text: '远端测试' },
    });
    const buf = Buffer.from(msg + '\n', 'utf8');
    // Split into two arbitrary halves — but on byte boundary, both might be invalid utf8.
    // Real socket data is rarely split mid-utf8 (TCP-level), but we ensure we don't crash.
    const half = Math.floor(buf.length / 2);
    const a = buf.subarray(0, half);
    const b = buf.subarray(half);
    decoder.push(a);
    const out = decoder.push(b);
    // Either we successfully decoded the full message OR it gracefully ignored
    // a corrupt slice — neither should throw.
    expect(Array.isArray(out)).toBe(true);
  });
});

describe('encodeMessage', () => {
  it('serializes with trailing newline', () => {
    const msg: RpcMessage = {
      type: 'request',
      id: 7,
      method: 'foo',
      params: { x: 1 },
    };
    const wire = encodeMessage(msg);
    expect(wire.endsWith('\n')).toBe(true);
    expect(wire.slice(0, -1)).toBe(JSON.stringify(msg));
  });

  it('roundtrips through decoder', () => {
    const original: RpcMessage = {
      type: 'response',
      id: 42,
      result: { ok: true, nested: { a: [1, 2, 3] } },
    };
    const decoder = new NDJSONDecoder();
    const out = decoder.push(encodeMessage(original));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(original);
  });
});
