/**
 * outboundImageCompress.ts — 控制端出方向图片附件的上传前压缩。
 * ---------------------------------------------------------------------------
 * 远程会话贴图的链路是「控制端全量上传 OSS → 被控端全量下载物化 → 被控端
 * ImageResizer 缩到 1568px 才喂模型」——不在源头压,两跳网络传的都是最终会被
 * 扔掉的字节。本模块在 outboundMedia 上传 OSS 前做一次降采样/重压缩。
 *
 * 策略与 mobile 端 prepareMobileImageAttachmentForUpload 同口径,保证两端行为
 * 一致可预期:
 *  - 仅处理 image/png 与 image/jpeg;GIF/WebP(可能带动画)及其它格式直通。
 *  - 最长边 > 2048px 等比降采样(fit inside,不放大)。
 *  - JPEG:尺寸在限内但体积 > 1MB 也重编码 q80;又小又轻的直通。
 *  - PNG:只降采样不转格式(保透明;截图文字在 PNG 下更清晰),尺寸在限内直通。
 *  - 防膨胀:产物不比原字节小 → 用原字节。
 *  - EXIF 方向在重编码前物化(sharp rotate()),避免缩图后方向元数据丢失导致横竖颠倒。
 *
 * 压缩只是优化:sharp 不可用 / 解码失败 / 超时(5s 软超时)一律静默回退原字节,
 * 绝不阻断消息发送。调用方只压「视觉上下文」语义的来源(xdt-image:// 缓存、内存
 * base64——截图/剪贴板/生成图);用户显式给出的磁盘路径附件是「字节精确」语义,
 * 由调用方直接跳过本模块。
 */

import { createLogger } from '../logger';

const log = createLogger('device-link:outboundImageCompress');

/** 上传图片最长边上限(px),与 mobile 端同值。 */
export const OUTBOUND_IMAGE_MAX_EDGE = 2048;
/** JPEG 重编码质量,与 mobile 端 0.8 同口径。 */
export const OUTBOUND_IMAGE_JPEG_QUALITY = 80;
/** JPEG 尺寸已在限内时,体积超过该阈值才值得重编码。 */
export const OUTBOUND_IMAGE_RECOMPRESS_MIN_BYTES = 1024 * 1024;
/**
 * 压缩输入体量上限:调用方在 readFile 前用 stat 把关,超限直接流式上传原图——
 * 别把病态大图整读进 main 进程内存造成尖峰/OOM(uploadLocalFile 本是流式的)。
 */
export const OUTBOUND_IMAGE_INPUT_MAX_BYTES = 48 * 1024 * 1024;
/** 单图软超时:超时放弃压缩用原字节(对齐 ImageResizer 的取舍)。 */
const COMPRESS_TIMEOUT_MS = 5000;

export interface OutboundImagePlan {
  format: 'jpeg' | 'png';
  /** true 时若无需降采样则放弃压缩(返回 null 用原字节)。 */
  skipWithoutResize: boolean;
}

/**
 * 该 mime 是否存在任何可能的压缩收益(与字节数无关)。调用方用它决定值不值得把
 * 文件整读进内存——gif/webp/未知 mime 的 plan 恒为 null,读了也只会原样丢弃。
 */
export function mayCompressOutboundImage(mimeType: string | undefined): boolean {
  return planOutboundImageCompression(mimeType, Number.MAX_SAFE_INTEGER) !== null;
}

/** 按 mimeType + 字节数决定压缩策略(纯函数);null = 直通不压。 */
export function planOutboundImageCompression(
  mimeType: string | undefined,
  size: number,
): OutboundImagePlan | null {
  if (mimeType === 'image/png') return { format: 'png', skipWithoutResize: true };
  if (mimeType === 'image/jpeg') {
    return {
      format: 'jpeg',
      skipWithoutResize: size > 0 && size <= OUTBOUND_IMAGE_RECOMPRESS_MIN_BYTES,
    };
  }
  return null;
}

export interface OutboundImageTransformInput {
  bytes: Buffer;
  maxEdge: number;
  format: 'jpeg' | 'png';
  quality: number;
  skipWithoutResize: boolean;
}

/** 图片变换实现(可注入,单测用假实现避免真实解码);返回 null 表示按 skip 规则放弃。 */
export type OutboundImageTransform = (
  input: OutboundImageTransformInput,
) => Promise<Buffer | null>;

export interface OutboundImageCompressDeps {
  transform?: OutboundImageTransform;
}

export interface CompressedOutboundImage {
  bytes: Buffer;
  contentType: 'image/jpeg' | 'image/png';
  ext: 'jpg' | 'png';
}

/**
 * 压缩一段图片字节。返回 null 表示保持原字节上传(格式直通 / 无收益 / 失败回退)。
 */
export async function compressOutboundImage(
  bytes: Buffer,
  mimeType: string | undefined,
  deps: OutboundImageCompressDeps = {},
): Promise<CompressedOutboundImage | null> {
  const plan = planOutboundImageCompression(mimeType, bytes.byteLength);
  if (!plan) return null;
  const transform = deps.transform ?? transformSharp;

  let out: Buffer | null;
  try {
    out = await withSoftTimeout(
      transform({
        bytes,
        maxEdge: OUTBOUND_IMAGE_MAX_EDGE,
        format: plan.format,
        quality: OUTBOUND_IMAGE_JPEG_QUALITY,
        skipWithoutResize: plan.skipWithoutResize,
      }),
      COMPRESS_TIMEOUT_MS,
    );
  } catch (err) {
    log.warn('outbound image compress failed, fallback to original bytes', {
      error: err instanceof Error ? err.message : String(err),
      mimeType,
      size: bytes.byteLength,
    });
    return null;
  }
  // 防膨胀:重编码没变小就传原字节。
  if (!out || out.byteLength <= 0 || out.byteLength >= bytes.byteLength) return null;
  return plan.format === 'png'
    ? { bytes: out, contentType: 'image/png', ext: 'png' }
    : { bytes: out, contentType: 'image/jpeg', ext: 'jpg' };
}

/** 软超时:超时抛错走回退;后台的 sharp 任务继续跑完被丢弃,无副作用。 */
async function withSoftTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`compress timeout after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// sharp 懒加载:带原生二进制,启动期不加载;不可用时整体降级为不压
// (与 file-browser/thumbnail、maker-core ImageResizer 同一取舍)。
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
    log.warn('sharp unavailable, outbound image compression disabled', {
      error: err instanceof Error ? err.message : String(err),
    });
    sharpInstance = null;
  }
  return sharpInstance;
}

/** 默认变换:sharp 解码 → EXIF 转正 → 按需 fit-inside 降采样 → 编码。 */
async function transformSharp(input: OutboundImageTransformInput): Promise<Buffer | null> {
  const sharp = loadSharp();
  if (!sharp) return null;
  const image = sharp(input.bytes).rotate();
  const meta = await image.metadata();
  if (!meta.width || !meta.height) return null;
  // 最长边对 EXIF 旋转不敏感(90° 旋转只是宽高互换),直接取 max 即可。
  const needsResize = Math.max(meta.width, meta.height) > input.maxEdge;
  if (!needsResize && input.skipWithoutResize) return null;
  const resized = needsResize
    ? image.resize({
      width: input.maxEdge,
      height: input.maxEdge,
      fit: 'inside',
      withoutEnlargement: true,
    })
    : image;
  return input.format === 'png'
    ? resized.png().toBuffer()
    : resized.jpeg({ quality: input.quality }).toBuffer();
}
