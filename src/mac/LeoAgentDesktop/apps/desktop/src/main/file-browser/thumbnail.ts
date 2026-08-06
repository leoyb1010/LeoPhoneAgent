/**
 * thumbnail.ts
 * ---------------------------------------------------------------------------
 * 被控端图片缩略图生成:服务手机版文件浏览网格视图的 `file-browser:remote-op`
 * `thumbnail` op。读盘 → sharp 缩到小边长 → webp → base64,由 invoke 回包直接
 * 携带(256px webp 通常 5-40KB,离 device-link 1.8MB 帧预算很远),不经 OSS。
 *
 * 与 inlineImageCompressor 的取舍一致:sharp 懒加载(带原生二进制,启动期不
 * 加载),不可用 / 解码失败 / 超时都返回结构化失败,调用方(手机端网格)静默
 * 回退类型占位图——缩略图是装饰性内容,任何失败都不该冒错误 UI。
 * 不做被控端缓存:sharp 256px 单次毫秒级,手机端有 path+mtime 磁盘缓存兜底。
 */

import { promises as fsp } from 'node:fs';

import { createLogger } from '../logger.js';

const log = createLogger('file-browser/thumbnail');

type SharpModule = (typeof import('sharp'))['default'];
let sharpInstance: SharpModule | null = null;
let sharpLoadAttempted = false;

function loadSharp(): SharpModule | null {
  if (sharpLoadAttempted) return sharpInstance;
  sharpLoadAttempted = true;
  try {
    const req: NodeJS.Require =
      typeof require !== 'undefined' ? require : (eval('require') as NodeJS.Require);
    sharpInstance = req('sharp') as SharpModule;
  } catch (err) {
    log.warn('sharp unavailable, file thumbnails disabled', {
      error: err instanceof Error ? err.message : String(err),
    });
    sharpInstance = null;
  }
  return sharpInstance;
}

/** 输入文件大小上限:相册原图/设计稿常见 10-20MB,再往上解码成本失控。 */
const THUMB_MAX_INPUT_BYTES = 48 * 1024 * 1024;
const THUMB_MAX_EDGE_PX = 256;
const THUMB_WEBP_QUALITY = 70;
const TIMEOUT_MS = 5_000;

export type FileThumbnailResult =
  | { ok: true; dataBase64: string; mimeType: 'image/webp'; width: number; height: number }
  | { ok: false; code: 'THUMB_UNSUPPORTED' | 'THUMB_TOO_LARGE' | 'THUMB_FAILED'; message?: string };

/**
 * 为绝对路径的图片文件生成缩略图。路径安全(workdir 内、realpath 校验)由
 * 调用方(device-op)负责,本函数只做"读盘 + 缩放"。永不 throw。
 */
export async function generateFileThumbnail(absPath: string): Promise<FileThumbnailResult> {
  const sharp = loadSharp();
  if (!sharp) return { ok: false, code: 'THUMB_UNSUPPORTED', message: 'sharp unavailable' };

  let input: Buffer;
  try {
    const st = await fsp.stat(absPath);
    if (!st.isFile()) return { ok: false, code: 'THUMB_FAILED', message: 'not a file' };
    if (st.size > THUMB_MAX_INPUT_BYTES) {
      return { ok: false, code: 'THUMB_TOO_LARGE', message: `input ${st.size} bytes` };
    }
    input = await fsp.readFile(absPath);
  } catch (err) {
    return { ok: false, code: 'THUMB_FAILED', message: String(err) };
  }

  // catch 必须挂在 race 之前:超时分支先返回后,work 若在后台以异常结束,
  // 该 rejection 没有等待方,会逃逸成主进程 unhandledRejection。
  const work = (async (): Promise<FileThumbnailResult> => {
    const out = await sharp(input, { failOn: 'none' })
      .rotate()
      .resize({
        width: THUMB_MAX_EDGE_PX,
        height: THUMB_MAX_EDGE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: THUMB_WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return {
      ok: true,
      dataBase64: out.data.toString('base64'),
      mimeType: 'image/webp',
      width: out.info.width,
      height: out.info.height,
    };
  })().catch((err): FileThumbnailResult => ({
    // 非图片 / 损坏数据 / sharp 不支持的格式(如部分 HEIC 编译配置)。
    ok: false,
    code: 'THUMB_FAILED',
    message: err instanceof Error ? err.message : String(err),
  }));

  const timeout = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), TIMEOUT_MS).unref?.();
  });

  const result = await Promise.race([work, timeout]);
  if (result === 'timeout') {
    log.warn('file thumbnail timeout', { absPath, timeoutMs: TIMEOUT_MS });
    return { ok: false, code: 'THUMB_FAILED', message: 'timeout' };
  }
  return result;
}
