/**
 * 文件浏览的跨屏公共动作:发送到会话(composer 草稿注入)、gzip 文本解码。
 */
import { ungzip } from 'pako';

import {
  readComposerDocumentDraftSync,
  readComposerDraftSync,
  saveComposerDocumentDraft,
  saveComposerDraft,
} from '@/session/composerDraftStore';
import {
  appendComposerNode,
  composerDocumentProjectedText,
  mentionComposerNode,
  textComposerDocument,
} from '@/session/composerDocument';
import { serializeAtResource } from '@/session/composerPalette';
import { imageMimeFromUrl } from '@/session/remoteMediaDiskCache';

/** 文件浏览导出分享的 mime 推断:图片沿用既有映射,常见文档/音视频补一层。 */
const SHARE_MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  json: 'application/json',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
};

/** 按文件名推断分享 mime;未知扩展名回退二进制流(此时靠传原始文件名保类型)。 */
export function shareMimeForFileName(name: string): string {
  const fromImage = imageMimeFromUrl(name);
  if (fromImage) return fromImage;
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (ext && SHARE_MIME_BY_EXT[ext]) || 'application/octet-stream';
}

/**
 * 把文件引用合并进会话 composer 草稿,返回合并后的草稿全文。
 *
 * 引用序列化复用 composer 的 `serializeAtResource`(含空格/引号的路径包成
 * `@"..."`,目录带尾斜杠),与 @ 面板插入的 mention 完全同构,agent 侧解析
 * 不会在第一个空格截断。调用方拿返回值经 route param `draft` 导航回会话页
 * ——会话页的 routeDraft effect 以「内存草稿优先」恢复,所以必须先写 store
 * 再变更 routeDraft key 触发恢复(会话页在栈下层保持挂载,不会重新 mount)。
 */
export function mergePathIntoComposerDraft(
  sessionId: string,
  relPath: string,
  kind: 'file' | 'dir' = 'file',
): string {
  const existing = readComposerDraftSync(sessionId) ?? '';
  const token = serializeAtResource({ type: kind, relPath });
  if (existing.includes(token)) return existing;
  const currentDocument = readComposerDocumentDraftSync(sessionId) ?? textComposerDocument(existing);
  const separated = existing.length > 0 && !existing.endsWith(' ') && !existing.endsWith('\n')
    ? appendComposerNode(currentDocument, { type: 'text', text: ' ' })
    : currentDocument;
  const withMention = appendComposerNode(
    separated,
    mentionComposerNode({ type: kind, relPath }),
  );
  const mergedDocument = appendComposerNode(withMention, { type: 'text', text: ' ' });
  const merged = composerDocumentProjectedText(mergedDocument);
  saveComposerDocumentDraft(sessionId, mergedDocument);
  saveComposerDraft(sessionId, merged);
  return merged;
}

/** readFile 返回 contentEncoding:'gzip' 时的解码(base64 → gunzip → utf8)。 */
export function decodeGzipBase64Text(contentBase64: string): string {
  return ungzip(base64ToUint8Array(contentBase64), { to: 'string' });
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = typeof atob === 'function' ? atob(base64) : decodeBase64Fallback(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Hermes 老版本无全局 atob 的兜底(实现对齐 mobileRealtimeAudio 的做法)。 */
function decodeBase64Fallback(base64: string): string {
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  let output = '';
  let i = 0;
  while (i < clean.length) {
    const enc1 = BASE64_ALPHABET.indexOf(clean.charAt(i++));
    const enc2 = BASE64_ALPHABET.indexOf(clean.charAt(i++));
    const enc3 = BASE64_ALPHABET.indexOf(clean.charAt(i++));
    const enc4 = BASE64_ALPHABET.indexOf(clean.charAt(i++));
    const chr1 = (enc1 << 2) | (enc2 >> 4);
    const chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
    const chr3 = ((enc3 & 3) << 6) | enc4;
    output += String.fromCharCode(chr1);
    // `=` 填充位 indexOf 返回 -1;字母表只有 64 个字符,索引恒在 0-63。
    if (enc3 !== -1) output += String.fromCharCode(chr2);
    if (enc4 !== -1) output += String.fromCharCode(chr3);
  }
  return output;
}
