/**
 * [e2e] ChaCha20-Poly1305 AEAD（RFC 8439），纯 TypeScript。
 *
 * 为什么不用 node:crypto：LeoBot 跑在 Electron 里，Electron 的加密库是 BoringSSL，
 * `createCipheriv("chacha20-poly1305")` 直接报 Unknown cipher。结果 1.12.0 的 Mac 端
 * 一个信封都解不开，所有手机请求都退回明文中继。这里自己实现，和运行时无关。
 * 正确性由 relayE2E.test.ts 里 iOS（CryptoKit）的跨端向量和 RFC 8439 §2.8.2 向量保证。
 */

function rotl(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function quarterRound(s: Uint32Array, a: number, b: number, c: number, d: number): void {
  s[a] = (s[a]! + s[b]!) >>> 0; s[d] = rotl(s[d]! ^ s[a]!, 16);
  s[c] = (s[c]! + s[d]!) >>> 0; s[b] = rotl(s[b]! ^ s[c]!, 12);
  s[a] = (s[a]! + s[b]!) >>> 0; s[d] = rotl(s[d]! ^ s[a]!, 8);
  s[c] = (s[c]! + s[d]!) >>> 0; s[b] = rotl(s[b]! ^ s[c]!, 7);
}

function chachaBlock(key: Uint8Array, counter: number, nonce: Uint8Array): Uint8Array {
  const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
  const nonceView = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  const state = new Uint32Array(16);
  state[0] = 0x61707865; state[1] = 0x3320646e; state[2] = 0x79622d32; state[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) state[4 + i] = view.getUint32(i * 4, true);
  state[12] = counter >>> 0;
  for (let i = 0; i < 3; i++) state[13 + i] = nonceView.getUint32(i * 4, true);
  const working = state.slice();
  for (let i = 0; i < 10; i++) {
    quarterRound(working, 0, 4, 8, 12); quarterRound(working, 1, 5, 9, 13);
    quarterRound(working, 2, 6, 10, 14); quarterRound(working, 3, 7, 11, 15);
    quarterRound(working, 0, 5, 10, 15); quarterRound(working, 1, 6, 11, 12);
    quarterRound(working, 2, 7, 8, 13); quarterRound(working, 3, 4, 9, 14);
  }
  const out = new Uint8Array(64);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) outView.setUint32(i * 4, (working[i]! + state[i]!) >>> 0, true);
  return out;
}

function chacha20(key: Uint8Array, counter: number, nonce: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let offset = 0, block = counter; offset < data.length; offset += 64, block++) {
    const stream = chachaBlock(key, block, nonce);
    const end = Math.min(64, data.length - offset);
    for (let i = 0; i < end; i++) out[offset + i] = data[offset + i]! ^ stream[i]!;
  }
  return out;
}

/** Poly1305，用 BigInt 做 130 位模运算；信封都很小（≤ 4 MB），性能足够。 */
function poly1305(key: Uint8Array, message: Uint8Array): Uint8Array {
  const le = (bytes: Uint8Array): bigint => {
    let value = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]!);
    return value;
  };
  const r = le(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = le(key.subarray(16, 32));
  const p = (1n << 130n) - 5n;
  let acc = 0n;
  for (let offset = 0; offset < message.length; offset += 16) {
    const chunk = message.subarray(offset, Math.min(offset + 16, message.length));
    const n = le(chunk) + (1n << BigInt(8 * chunk.length));
    acc = ((acc + n) * r) % p;
  }
  acc = (acc + s) & ((1n << 128n) - 1n);
  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    tag[i] = Number(acc & 0xffn);
    acc >>= 8n;
  }
  return tag;
}

function pad16(length: number): Uint8Array {
  return new Uint8Array((16 - (length % 16)) % 16);
}

function macData(aad: Uint8Array, cipherText: Uint8Array): Uint8Array {
  const lengths = new Uint8Array(16);
  const view = new DataView(lengths.buffer);
  view.setBigUint64(0, BigInt(aad.length), true);
  view.setBigUint64(8, BigInt(cipherText.length), true);
  const parts = [aad, pad16(aad.length), cipherText, pad16(cipherText.length), lengths];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** 返回 密文 ‖ 16 字节标签。 */
export function chachaPolySeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  if (key.length !== 32 || nonce.length !== 12) throw new Error("chacha20-poly1305: bad key or nonce length");
  const polyKey = chachaBlock(key, 0, nonce).subarray(0, 32);
  const cipherText = chacha20(key, 1, nonce, plaintext);
  const tag = poly1305(polyKey, macData(aad, cipherText));
  const out = new Uint8Array(cipherText.length + 16);
  out.set(cipherText);
  out.set(tag, cipherText.length);
  return out;
}

/** 输入 密文 ‖ 标签；标签不对抛错。 */
export function chachaPolyOpen(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Uint8Array {
  if (key.length !== 32 || nonce.length !== 12) throw new Error("chacha20-poly1305: bad key or nonce length");
  if (sealed.length < 16) throw new Error("chacha20-poly1305: ciphertext too short");
  const cipherText = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  const polyKey = chachaBlock(key, 0, nonce).subarray(0, 32);
  if (!constantTimeEqual(poly1305(polyKey, macData(aad, cipherText)), tag)) {
    throw new Error("chacha20-poly1305: authentication failed");
  }
  return chacha20(key, 1, nonce, cipherText);
}
