/**
 * .xdtshare 的密码加密层:scrypt KDF + AES-256-GCM。
 *
 * 只依赖 node:crypto,不落任何盘;密码仅存在于参数与局部变量,绝不写日志。
 * 头结构与 AAD 语义见 xdtshareFormat.pure.ts。错误密码的唯一判定路径是
 * GCM authTag 校验失败(decipher.final() 抛)→ SHARE_PASSWORD_WRONG;
 * tag 通过但 payload 不是 zip → SHARE_FILE_INVALID(文件在加密前就坏了)。
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  scryptSync,
} from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import {
  XDTSHARE_AAD_LENGTH,
  XDTSHARE_IV_LENGTH,
  XDTSHARE_SALT_LENGTH,
  XDTSHARE_SCRYPT_LOG_N,
  XDTSHARE_SCRYPT_P,
  XDTSHARE_SCRYPT_R,
  XdtshareError,
  decodeXdtshareHeader,
  encodeEncryptedHeader,
  encodePlainHeader,
  looksLikeZip,
} from './xdtshareFormat.pure.js';

/**
 * scrypt 需要 128 * N * r 字节内存(我们的导出参数 N=2^15, r=8 → 32MB),Node 默认
 * maxmem 恰好 32MB 会 ENOMEM,必须显式抬高。注意 512MB **不覆盖**头内参数上界的
 * 全空间(logN=20 + r=32 需要 4GB):被篡改但仍在上界内的参数会让 scryptSync 抛
 * "Invalid scrypt params"——openPayload 已把整段 KDF+解密包进 try,统一映射为
 * SHARE_PASSWORD_WRONG(篡改参数本就不可能解密成功,语义等价),不放大 maxmem
 * 以免恶意头造成 GB 级内存放大。
 */
const SCRYPT_MAXMEM = 512 * 1024 * 1024;
const KEY_LENGTH = 32;

function deriveKey(password: string, salt: Buffer, logN: number, r: number, p: number): Buffer {
  // NFC 归一化:mac/win 输入法对组合字符的编码差异不应导致"同一个密码"解不开。
  return scryptSync(Buffer.from(password.normalize('NFC'), 'utf8'), salt, KEY_LENGTH, {
    N: 2 ** logN,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** deriveKey 的异步版(libuv 线程池跑 KDF,不占 main 进程事件循环)。 */
function deriveKeyAsync(
  password: string,
  salt: Buffer,
  logN: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(password.normalize('NFC'), 'utf8'),
      salt,
      KEY_LENGTH,
      { N: 2 ** logN, r, p, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** AES 分块尺寸:单块 update 约几 ms 量级,块间让出事件循环,避免长停顿。 */
const SEAL_CHUNK_BYTES = 8 * 1024 * 1024;

/** 打包明文 .xdtshare 文件字节(头 + zip 原样)。 */
export function buildPlainFile(zipBytes: Buffer): Buffer {
  return Buffer.concat([encodePlainHeader(), zipBytes]);
}

/**
 * 用密码加密 zip payload,返回完整 .xdtshare 文件字节。
 *
 * 异步语义(review bot 指出同步版会卡死 main 进程):KDF 走 crypto.scrypt
 * 的线程池版;AES-GCM 按 8MB 分块 update、块间 setImmediate 让出事件循环,
 * 256MB 上限 payload 也不会造成 main 进程长停顿(其它窗口 / IPC 正常响应)。
 */
export async function sealPayload(zipBytes: Buffer, password: string): Promise<Buffer> {
  if (!password) {
    throw new XdtshareError('SHARE_PASSWORD_REQUIRED', 'password must not be empty');
  }
  const salt = randomBytes(XDTSHARE_SALT_LENGTH);
  const iv = randomBytes(XDTSHARE_IV_LENGTH);
  const header = encodeEncryptedHeader({
    logN: XDTSHARE_SCRYPT_LOG_N,
    r: XDTSHARE_SCRYPT_R,
    p: XDTSHARE_SCRYPT_P,
    salt,
    iv,
  });
  const key = await deriveKeyAsync(
    password,
    salt,
    XDTSHARE_SCRYPT_LOG_N,
    XDTSHARE_SCRYPT_R,
    XDTSHARE_SCRYPT_P,
  );
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header.subarray(0, XDTSHARE_AAD_LENGTH));
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < zipBytes.length; offset += SEAL_CHUNK_BYTES) {
    chunks.push(cipher.update(zipBytes.subarray(offset, offset + SEAL_CHUNK_BYTES)));
    await yieldToEventLoop();
  }
  chunks.push(cipher.final());
  // authTag 只能在加密完成后回写头部 [44, 60)。
  cipher.getAuthTag().copy(header, XDTSHARE_AAD_LENGTH);
  return Buffer.concat([header, ...chunks]);
}

export interface OpenPayloadResult {
  zipBytes: Buffer;
  encrypted: boolean;
}

/**
 * 打开 .xdtshare 文件:解析头、按需解密、校验 zip magic。
 * - 加密文件未给密码 → SHARE_PASSWORD_REQUIRED(调用方以此驱动"要密码"的 UI 分支)
 * - 密码错误 / 文件被篡改 → SHARE_PASSWORD_WRONG
 * - 其它结构问题 → SHARE_FILE_INVALID / SHARE_VERSION_UNSUPPORTED
 */
export function openPayload(fileBytes: Buffer, password?: string): OpenPayloadResult {
  const header = decodeXdtshareHeader(fileBytes);
  if (header.cipher === 0) {
    const zipBytes = fileBytes.subarray(header.payloadOffset);
    if (!looksLikeZip(zipBytes)) {
      throw new XdtshareError('SHARE_FILE_INVALID', 'plain payload is not a zip archive');
    }
    return { zipBytes: Buffer.from(zipBytes), encrypted: false };
  }

  if (!password) {
    throw new XdtshareError('SHARE_PASSWORD_REQUIRED', 'file is encrypted, password required');
  }
  let zipBytes: Buffer;
  try {
    // deriveKey 必须在 try 内:头内 KDF 参数虽过了解码上界,仍可能超出 maxmem
    // (如被篡改成 logN=20/r=32 → 4GB),scryptSync 会抛非 XdtshareError 的裸错;
    // 这类篡改与 GCM tag 失败同语义,统一映射 SHARE_PASSWORD_WRONG,保住
    // "本函数只抛 SHARE_* code" 的契约。
    const key = deriveKey(password, header.salt, header.logN, header.r, header.p);
    const decipher = createDecipheriv('aes-256-gcm', key, header.iv);
    decipher.setAAD(header.aad);
    decipher.setAuthTag(header.authTag);
    zipBytes = Buffer.concat([
      decipher.update(fileBytes.subarray(header.payloadOffset)),
      decipher.final(),
    ]);
  } catch {
    // KDF 参数非法/超内存、或 GCM tag 校验失败:密码错误或文件被篡改,
    // 对用户统一为"密码错误或文件已损坏"。
    throw new XdtshareError('SHARE_PASSWORD_WRONG', 'wrong password or corrupted file');
  }
  if (!looksLikeZip(zipBytes)) {
    throw new XdtshareError('SHARE_FILE_INVALID', 'decrypted payload is not a zip archive');
  }
  return { zipBytes, encrypted: true };
}
