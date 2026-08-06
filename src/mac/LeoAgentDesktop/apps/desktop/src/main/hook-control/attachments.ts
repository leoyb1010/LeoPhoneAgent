/**
 * hook-control/attachments.ts
 * ---------------------------------------------------------------------------
 * 入站附件(base64)的纯解码 + 校验 —— 图片/文件分流解出字节。
 *
 * 刻意只依赖 node 内建 + 类型, 不 import electron / cindy-media / maker-host:
 * 真正落盘(受支持媒体写 cindy-media 媒体总仓、普通文件写 hook 附件目录,
 * 依赖 app.getPath)由 session-runner 承担, 本文件保持纯函数便于单测直接 import
 * (session-runner 顶层拉整条 maker + electron 链, 直接测它会连带加载失败)。
 * 图片白名单权威来源是 hook-protocol 的 isSupportedImageMime(png/jpeg/gif/
 * webp), 与 provider 下载端同一份; 白名单外的附件不再丢弃 —— server 已放开
 * 全 MIME 转发(2026-07), 这里按「文件」分流。session-runner 会将受支持
 * 媒体交给 cindy-media、明确拒绝可识别但尚不受支持的媒体格式，其余普通
 * 文件再交给 agent。
 */

import { isSupportedImageMime, type TaskAttachment } from '@cindy/slack-hook-protocol';

/** 解码后的图片附件(字节 + 元信息); session-runner 据此写 cindy-media 媒体总仓。 */
export interface DecodedImage {
  bytes: Buffer;
  mimeType: string;
  /** 对端原文件名(仅作显示 originalName / 扩展名推断参考, 不参与落盘路径)。 */
  name: string | null;
}

/** 解码后的非图片附件; session-runner 再按媒体白名单选择媒体总仓或普通文件目录。 */
export interface DecodedFile {
  bytes: Buffer;
  mimeType: string;
  /** 对端原文件名(展示与落盘文件名参考, 落盘前必须消毒)。 */
  name: string | null;
}

/** 只放行 agent 可消费的图片(白名单权威来源: hook-protocol, 与 provider 下载端一致)。 */
export function isImageMime(mime: string): boolean {
  return isSupportedImageMime(mime);
}

/**
 * 解码入站 base64 附件, 按「agent 可直接看的图片 / 其余一律当文件」分流。
 * 空字节跳过(只 warn, 不抛), 不影响其它附件,并通过 skipped 让调用方在最终
 * 回复里显式报告附件处理不完整。返回的字节不落盘 —— 图片由调用方交给
 * cindy-media ingest(内容指纹落盘, 不信任对端 name), 其余项由调用方再按
 * 媒体白名单决定写媒体总仓或 hook 附件目录。
 */
export function decodeAttachments(
  attachments: TaskAttachment[],
  log: { warn(msg: string): void },
): { images: DecodedImage[]; files: DecodedFile[]; skipped: number } {
  const images: DecodedImage[] = [];
  const files: DecodedFile[] = [];
  let skipped = 0;
  for (const att of attachments) {
    // Buffer.from(,'base64') 对非法字符宽松跳过、不抛; 空/全非法 -> 空字节, 由长度判丢弃
    const bytes = Buffer.from(att.dataBase64, 'base64');
    if (bytes.length === 0) {
      skipped += 1;
      log.warn(`hook attachment skipped (empty bytes, mime ${att.mimeType})`);
      continue;
    }
    if (isImageMime(att.mimeType)) {
      // 规范化 MIME: 统一小写、别名 image/jpg -> image/jpeg。下游 imageCacheStore
      // 按精确小写 key 查扩展名/渲染 mime, 不归一会落成 .bin 导致渲染类型错。
      const m = att.mimeType.trim().toLowerCase();
      const mimeType = m === 'image/jpg' ? 'image/jpeg' : m;
      images.push({ bytes, mimeType, name: att.name });
    } else {
      files.push({ bytes, mimeType: att.mimeType, name: att.name });
    }
  }
  return { images, files, skipped };
}

/**
 * 落盘文件名消毒: 取 basename、替换路径分隔/控制/Windows 保留字符、去首尾
 * 点与空白、限长; 结果为空时回退 'attachment'。唯一性由调用方加前缀保证,
 * 这里只管安全(对端 name 不可信)。
 */
export function sanitizeAttachmentName(name: string | null): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"|?*]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  if (cleaned.length === 0) return 'attachment';
  // Windows device names remain reserved even with an extension (for example
  // CON.txt). Prefix rather than discard the user's recognizable filename.
  const stem = cleaned.split('.', 1)[0]?.toUpperCase() ?? '';
  const windowsReserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
  return windowsReserved ? `_${cleaned}`.slice(0, 120) : cleaned;
}
