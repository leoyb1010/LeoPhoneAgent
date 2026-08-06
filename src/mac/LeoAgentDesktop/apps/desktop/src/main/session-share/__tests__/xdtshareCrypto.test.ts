import { describe, expect, it } from 'vitest';

import { XdtshareError, decodeXdtshareHeader } from '../xdtshareFormat.pure.js';
import { buildPlainFile, openPayload, sealPayload } from '../xdtshareCrypto.js';

// 假 zip payload:只需要 zip local file header magic 打头。
const ZIP_BYTES = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('fake zip body 会话数据')]);

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as XdtshareError).code;
  }
  throw new Error('expected throw');
}

describe('xdtshareCrypto', () => {
  it('plain file roundtrip', () => {
    const file = buildPlainFile(ZIP_BYTES);
    const opened = openPayload(file);
    expect(opened.encrypted).toBe(false);
    expect(opened.zipBytes.equals(ZIP_BYTES)).toBe(true);
  });

  it('seal → open roundtrip with correct password', async () => {
    const file = await sealPayload(ZIP_BYTES, 'p@ssw0rd 密码');
    const opened = openPayload(file, 'p@ssw0rd 密码');
    expect(opened.encrypted).toBe(true);
    expect(opened.zipBytes.equals(ZIP_BYTES)).toBe(true);
  });

  it('kdf params are read back from header, not from constants', async () => {
    const file = await sealPayload(ZIP_BYTES, 'x');
    const header = decodeXdtshareHeader(file);
    if (header.cipher !== 1) throw new Error('expected encrypted');
    expect(header.logN).toBe(15);
    expect(header.r).toBe(8);
    expect(header.p).toBe(1);
    expect(header.salt.length).toBe(16);
    expect(header.iv.length).toBe(12);
  });

  it('password is NFC-normalized (composed vs decomposed input decrypts the same file)', async () => {
    // "é" 的两种 Unicode 表示:U+00E9 与 e + U+0301。
    const composed = 'café';
    const decomposed = 'café';
    const file = await sealPayload(ZIP_BYTES, composed);
    expect(openPayload(file, decomposed).zipBytes.equals(ZIP_BYTES)).toBe(true);
  });

  it('wrong password → SHARE_PASSWORD_WRONG', async () => {
    const file = await sealPayload(ZIP_BYTES, 'right');
    expect(codeOf(() => openPayload(file, 'wrong'))).toBe('SHARE_PASSWORD_WRONG');
  });

  it('encrypted file without password → SHARE_PASSWORD_REQUIRED', async () => {
    const file = await sealPayload(ZIP_BYTES, 'secret');
    expect(codeOf(() => openPayload(file))).toBe('SHARE_PASSWORD_REQUIRED');
  });

  it('tampering with AAD-covered header bytes is detected', async () => {
    const file = await sealPayload(ZIP_BYTES, 'secret');
    const tampered = Buffer.from(file);
    tampered[16] ^= 0xff; // 改 salt 首字节(在 AAD 覆盖范围内,不受参数上界预检)
    // 篡改 salt 会同时改变派生 key 与 AAD,两条路都必然 tag fail。
    expect(codeOf(() => openPayload(tampered, 'secret'))).toBe('SHARE_PASSWORD_WRONG');
  });

  it('out-of-range KDF params planted in header are rejected before KDF runs', async () => {
    const file = await sealPayload(ZIP_BYTES, 'secret');
    const tampered = Buffer.from(file);
    tampered[13] ^= 0xff; // r: 8 → 247,超出解码端上界
    expect(codeOf(() => openPayload(tampered, 'secret'))).toBe('SHARE_FILE_INVALID');
  });

  it('in-range but oversized KDF params (scrypt exceeds maxmem) map to SHARE_PASSWORD_WRONG', async () => {
    const file = await sealPayload(ZIP_BYTES, 'secret');
    const tampered = Buffer.from(file);
    tampered.writeUInt8(20, 12); // logN: 15 → 20(在解码上界内)
    tampered.writeUInt8(32, 13); // r: 8 → 32 → 128·2^20·32 = 4GB > maxmem
    // scryptSync 抛裸错也必须被映射成 SHARE_* 契约内的错误码,不能逃逸。
    expect(codeOf(() => openPayload(tampered, 'secret'))).toBe('SHARE_PASSWORD_WRONG');
  });

  it('tampering with ciphertext is detected', async () => {
    const file = await sealPayload(ZIP_BYTES, 'secret');
    const tampered = Buffer.from(file);
    tampered[tampered.length - 1] ^= 0x01;
    expect(codeOf(() => openPayload(tampered, 'secret'))).toBe('SHARE_PASSWORD_WRONG');
  });

  it('flipping cipher byte to plaintext does not smuggle ciphertext through', async () => {
    const file = await sealPayload(ZIP_BYTES, 'secret');
    const tampered = Buffer.from(file);
    tampered.writeUInt8(0, 9); // cipher: 1 → 0
    // 密文不是 zip magic 开头 → SHARE_FILE_INVALID(而不是被当明文吞掉)。
    expect(codeOf(() => openPayload(tampered))).toBe('SHARE_FILE_INVALID');
  });

  it('plain payload that is not a zip → SHARE_FILE_INVALID', () => {
    const file = buildPlainFile(Buffer.from('not a zip'));
    expect(codeOf(() => openPayload(file))).toBe('SHARE_FILE_INVALID');
  });

  it('empty password on seal → SHARE_PASSWORD_REQUIRED', async () => {
    await expect(sealPayload(ZIP_BYTES, '')).rejects.toMatchObject({
      code: 'SHARE_PASSWORD_REQUIRED',
    });
  });
});
