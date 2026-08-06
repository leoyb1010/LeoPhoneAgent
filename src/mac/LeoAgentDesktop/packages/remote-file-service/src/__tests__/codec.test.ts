/**
 * NdjsonLineDecoder 单测:chunk 任意切分、UTF-8 多字节断字、坏行容错。
 */

import { describe, expect, it } from 'vitest';

import { NdjsonLineDecoder, encodeNdjsonFrame } from '../codec.js';

describe('NdjsonLineDecoder', () => {
  it('reassembles frames across arbitrary chunk boundaries', () => {
    const dec = new NdjsonLineDecoder();
    const wire = encodeNdjsonFrame({ id: 1, ok: true, result: { hello: 'world' } });
    const out: unknown[] = [];
    for (const ch of wire) out.push(...dec.push(ch));
    expect(out).toEqual([{ id: 1, ok: true, result: { hello: 'world' } }]);
  });

  it('holds split multi-byte UTF-8 sequences across Buffer pushes', () => {
    const dec = new NdjsonLineDecoder();
    const wire = Buffer.from(encodeNdjsonFrame({ text: '中文😀内容' }), 'utf8');
    const cut = 9; // 故意切在多字节序列中间
    const out = [...dec.push(wire.subarray(0, cut)), ...dec.push(wire.subarray(cut))];
    expect(out).toEqual([{ text: '中文😀内容' }]);
  });

  it('reports corrupt lines and keeps decoding subsequent frames', () => {
    const corrupt: string[] = [];
    const dec = new NdjsonLineDecoder({ onCorruptLine: (line) => corrupt.push(line) });
    const out = dec.push('not-json\n{"ok":1}\n');
    expect(corrupt).toEqual(['not-json']);
    expect(out).toEqual([{ ok: 1 }]);
  });

  it('ignores blank lines and CRLF terminators', () => {
    const dec = new NdjsonLineDecoder();
    const out = dec.push('\r\n{"a":1}\r\n\n{"b":2}\n');
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
