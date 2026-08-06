/**
 * rangeResponse.ts — cindy 系媒体协议的 Range/206 响应组装(视频播放支持)。
 * ---------------------------------------------------------------------------
 * <video>/<audio> 元素靠 Range 请求做分片加载与 seek:协议只回整段 200、
 * 不带 Accept-Ranges 时,Chromium 的媒体管线直接黑屏——这正是 cindy-media://
 * 只服务图片时留下的欠账(本文件头注释当年写着"视频 Range 待补")。
 *
 * 模式与 xdt-video / xdt-audio 的手动 206 同款(scheme privilege 保持
 * stream:false);Range 解析复用 audioFileProtocol.parseRangeHeader(纯函数,
 * 已有测试),不再抄第三份。图片请求不带 Range 头 → 原样走 200 分支,行为不变。
 */

import { parseRangeHeader } from '../audioFileProtocol.js';

/** Buffer → 独立 ArrayBuffer(Response 不接受共享底层的偏移视图)。 */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * 按 Range 头组装 416 / 206 / 200 三态响应。
 * cacheControl 由调用方给(内容寻址地址可 immutable 长缓存)。
 */
export function buildRangedMediaResponse(params: {
  buffer: Buffer;
  mimeType: string;
  rangeHeader: string | null;
  cacheControl: string;
}): Response {
  const { buffer, mimeType, rangeHeader, cacheControl } = params;
  const totalSize = buffer.byteLength;
  const range = parseRangeHeader(rangeHeader, totalSize);

  if (range && range.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Type': mimeType,
        'Content-Range': `bytes */${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
      },
    });
  }

  if (range && range.kind === 'range') {
    const slice = buffer.subarray(range.start, range.end + 1);
    return new Response(toArrayBuffer(slice), {
      status: 206,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(slice.byteLength),
        'Content-Range': `bytes ${range.start}-${range.end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
      },
    });
  }

  return new Response(toArrayBuffer(buffer), {
    status: 200,
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(totalSize),
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
    },
  });
}
