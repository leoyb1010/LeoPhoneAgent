/**
 * annotationBurnIn — 标注烧录的共享实现(renderer)。
 *
 * 非破坏性标注架构下,矢量笔迹是唯一事实源,烧录位图只在两个时刻产生:
 *   1. 发送消息时(makerChatStore 物化 annotated 附件,模型必须读位图文件);
 *   2. lightbox 内"复制/另存为所见"这类即时导出。
 *
 * 源字节一律经 IPC 以 base64 进 renderer(data: URL 同源,规避自定义协议图
 * 打进 canvas 后 toBlob 被跨源 taint 拦截)。
 */

import {
  drawStrokesOnCanvas,
  type AnnotationStroke,
} from '@/components/chat/lightboxAnnotations';
import type { AttachedFile } from '@/lib/fileTypes';
import { createLogger } from '@/lib/logger';

const log = createLogger('AnnotationBurnIn');

/**
 * 剥掉 MIME 参数(`image/svg+xml;charset=utf-8` → `image/svg+xml`)。
 * 字节层所有出口统一输出**无参数** MIME:下游会拿它重构 `data:<mime>;base64,`
 * URL(另存为)或直接透传给 main 的 save-as / 缓存解析器,而那些解析器只认
 * 无参数形式——带参数会"按钮可见却必失败"(review P2)。
 */
function cleanImageMime(mime: string): string {
  return mime.split(';')[0].trim();
}

/**
 * data: 载荷上限,与 main 侧 REMOTE_IMAGE_MAX_BYTES 同一防线(renderer 不
 * import main 模块)。markdown 允许 data: 图源,模型可产出任意大载荷——
 * renderer 的复制/标注/光栅化会把它重建成 data URL 送进 `Image.decode()`,
 * 不设防会冻结/压垮 renderer(review P2)。按 URL 字符串长度保守估算
 * (base64 解码 ≈ len×3/4、URL-encoded 解码 ≤ len),超限即拒,不做精确解码。
 */
const IMAGE_MAX_BYTES = 100 * 1024 * 1024;

function assertDataUrlWithinLimit(estimatedBytes: number): void {
  if (estimatedBytes > IMAGE_MAX_BYTES) {
    throw new Error('图片过大');
  }
}

/** `xdt-file://local/?path=<enc>` → 绝对路径;非该 scheme 返回 null。 */
export function xdtFileUrlToPath(url: string): string | null {
  if (!url.startsWith('xdt-file://')) return null;
  try {
    return new URL(url).searchParams.get('path');
  } catch {
    return null;
  }
}

/**
 * 统一字节解析层:任意可见图片源 → {base64, mimeType}。
 * lightbox 的全部字节级动作(位图复制/标注烧录/光栅化发送)都建立在这里,
 * 能力判定因此从"scheme 白名单"退化为"字节可达 + 语义适用"两问:
 *   - xdt-image://     会话缓存,IPC 直读
 *   - xdt-file://      本地文件,经 media:read-image-bytes(与远程取图共用
 *                      100MB 上限——附件读取 IPC 只有 30MB,lightbox 能经流式
 *                      协议显示的大图会在字节动作上"能看却操作失败";MIME 也由
 *                      main 按扩展名/魔数统一推导,含 svg/bmp/ico)
 *   - data:            base64 直取;非 base64 形式 fetch 归一化(data: 同源)
 *   - http(s)://       经 main 下载(net.fetch,流式限流)
 *   - cindy-remote-media 经 main 复用协议取件管线(OSS 中转 / SSH)
 * 其余 scheme 抛错(调用方能力判定应已挡住,这里是防御)。
 */
export async function loadImageSourceBase64(
  src: string,
): Promise<{ base64: string; mimeType: string }> {
  if (src.startsWith('xdt-image://') || src.startsWith('cindy-media://')) {
    return window.electronAPI.readCachedImageAsBase64({ url: src });
  }
  const base64Match = /^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i.exec(src);
  if (base64Match) {
    assertDataUrlWithinLimit((base64Match[2].length * 3) / 4);
    return { base64: base64Match[2], mimeType: base64Match[1] };
  }
  if (/^data:image\//i.test(src)) {
    // 其余 data: 形式(非 base64 的 URL-encoded、或带 MIME 参数如
    // `;charset=utf-8` 的 base64):fetch 归一化(data: URL 同源),
    // blob.type 可能保留参数,统一剥掉。解码大小 ≤ URL 长度,先保守限流。
    assertDataUrlWithinLimit(src.length);
    const blob = await (await fetch(src)).blob();
    return {
      base64: await blobToBase64Payload(blob),
      mimeType: cleanImageMime(blob.type || 'image/png'),
    };
  }
  if (
    xdtFileUrlToPath(src) !== null ||
    /^https?:\/\//.test(src) ||
    src.startsWith('cindy-remote-media://')
  ) {
    const res = await window.electronAPI.readImageBytes({ url: src });
    return { base64: res.base64, mimeType: cleanImageMime(res.mimeType) };
  }
  throw new Error(`unsupported image source: ${src.slice(0, 32)}`);
}

/** 字节可达性:loadImageSourceBase64 能覆盖的源(能力判定的第一问)。 */
export function isImageBytesReachable(src: string): boolean {
  return (
    src.startsWith('xdt-image://') ||
    src.startsWith('cindy-media://') ||
    xdtFileUrlToPath(src) !== null ||
    /^data:image\//i.test(src) ||
    /^https?:\/\//.test(src) ||
    src.startsWith('cindy-remote-media://')
  );
}

/**
 * 烧录:原图 base64 → canvas(自然尺寸)→ 重放笔迹 → 位图 Blob。
 * JPEG 源默认保持 JPEG(避免照片转 PNG 体积爆炸),其余 PNG;
 * `outMimeOverride` 用于剪贴板等只收 PNG 的场景。
 */
export async function burnInAnnotations(
  source: { base64: string; mimeType: string },
  strokes: readonly AnnotationStroke[],
  outMimeOverride?: 'image/png' | 'image/jpeg',
): Promise<{ blob: Blob; mimeType: string }> {
  const image = new Image();
  image.src = `data:${source.mimeType};base64,${source.base64}`;
  await image.decode();

  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight);
  drawStrokesOnCanvas(ctx, strokes, image.naturalWidth, image.naturalHeight);

  const outMime =
    outMimeOverride ?? (source.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png');
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, outMime, 0.92),
  );
  if (!blob) throw new Error('encode failed');
  return { blob, mimeType: outMime };
}

/**
 * 该附件列表是否存在需要发送前烧录的标注图。调用方(makerChatStore)据此
 * 决定走同步发送路径还是 async 物化路径——"planMode 点击即消耗 / 乐观
 * enqueue"等同步语义只对无需物化的消息保证,不能为不存在的烧录支付一次
 * 微任务让步(planReviewDoneRace 测试守护该语义)。
 * `!f.annotated`:已物化过的附件(重试 retryFiles 场景)不再需要烧录。
 */
export function needsAnnotationMaterialize(files?: readonly AttachedFile[]): boolean {
  return Boolean(
    files?.some(
      (f) =>
        f.category === 'image' &&
        !f.annotated &&
        ((f.annotationStrokes?.length ?? 0) > 0 ||
          // 共享引用附件被撤光笔迹:发送前需要复制成私有副本(见
          // materializeAnnotatedAttachmentsForSend 的所有权说明)。
          (f.cacheUrlShared === true && Boolean(f.url))),
    ),
  );
}

/**
 * 发送时物化:把带矢量笔迹的图片附件烧录成位图。
 * - 缓存附件(有 url):烧录图写入会话缓存成为发送 url;物化前的 url(原图)
 *   记入 annotationSourceUrl、笔迹保留——两者随消息持久化,历史图可再编辑。
 * - base64 草稿附件:烧录结果直接替换 base64 随消息走。
 * - 烧录失败:降级发原图并剥离全部标注字段(不能带着 annotated 标发一张
 *   没有圈的图误导模型),只记日志不阻塞发送。
 * 幂等:`f.annotated` 的附件已是烧录产物,原样返回——远程 auth-retry 会把
 * 已物化的 retryFiles 重新送进本函数,若再烧一遍会把笔迹叠画到烧录图上、
 * annotationSourceUrl 也会被错误重指到烧录副本(review P2)。
 * `opts.stripAnnotationMeta`:remote(device-link/SSH)会话发送时剥离
 * annotationSourceUrl/annotationStrokes——它们指向控制端本地缓存,被控端
 * 无法解析,持久化过去只会产生悬空引用(review P2);annotated 保留,
 * hidden note 注入不受影响。
 * 无笔迹附件原样返回;整个列表无笔迹时零开销直返。
 */
export async function materializeAnnotatedAttachmentsForSend(
  files: readonly AttachedFile[] | undefined,
  sessionId: string,
  opts?: { stripAnnotationMeta?: boolean },
): Promise<AttachedFile[] | undefined> {
  if (!needsAnnotationMaterialize(files)) {
    return files ? [...files] : undefined;
  }
  return Promise.all(
    files!.map(async (f): Promise<AttachedFile> => {
      const strokes = f.annotationStrokes;
      if (f.category !== 'image' || f.annotated) return f;
      if (!strokes || strokes.length === 0) {
        // 共享引用附件(标注历史图进托盘)被撤光笔迹:没有烧录会产生私有
        // 文件,直接发送会把**历史消息的缓存文件**持久化进新消息——两条
        // 消息共享同一文件,历史侧被删除/清理时连带打断新消息(review P1)。
        // 发送前经 cache-for-session 复制出本会话私有副本。失败降级原样发送
        // (共享引用仍受 sweep 的 content 扫描保护,只是所有权语义欠佳)。
        if (f.cacheUrlShared && f.url) {
          return (await privatizeSharedAttachment(f, sessionId)) ?? f;
        }
        return f;
      }
      try {
        const source = f.url
          ? await loadImageSourceBase64(f.url)
          : f.base64
            ? { base64: f.base64, mimeType: f.mimeType }
            : null;
        if (!source) return f;
        const { blob, mimeType } = await burnInAnnotations(source, strokes);
        const ext = mimeType === 'image/jpeg' ? '.jpg' : '.png';
        const name = `annotated-${Date.now()}${ext}`;
        if (f.url) {
          const cached = await window.electronAPI.cacheImageFromBuffer({
            sessionId,
            buffer: new Uint8Array(await blob.arrayBuffer()),
            mimeType,
            suggestedName: name,
          });
          return {
            ...f,
            url: cached.url,
            name,
            originalName: name,
            ext,
            mimeType,
            size: blob.size,
            annotated: true,
            ...(opts?.stripAnnotationMeta
              ? { annotationSourceUrl: undefined, annotationStrokes: undefined }
              : { annotationSourceUrl: f.url }),
          };
        }
        return {
          ...f,
          base64: await blobToBase64Payload(blob),
          name,
          originalName: name,
          ext,
          mimeType,
          size: blob.size,
          annotated: true,
        };
      } catch (err) {
        log.warn('burn-in failed, sending original image without annotations', {
          name: f.name,
          error: err instanceof Error ? err.message : String(err),
        });
        const stripped: AttachedFile = {
          ...f,
          annotated: undefined,
          annotationSourceUrl: undefined,
          annotationStrokes: undefined,
        };
        // 共享引用附件烧录失败:降级发的是**历史消息的原图文件**,与上方撤光
        // 笔迹分支同一悬空引用问题——同样先私有化,失败再原样降级(review P2)。
        if (f.cacheUrlShared && f.url) {
          return (await privatizeSharedAttachment(stripped, sessionId)) ?? stripped;
        }
        return stripped;
      }
    }),
  );
}

/**
 * 共享引用附件(cacheUrlShared)经 cache-for-session 复制出本会话私有副本,
 * 避免新消息与历史消息共享同一缓存文件(历史侧被删除/清理时连带悬空)。
 * 失败返回 null,调用方决定降级语义;传入的附件字段(含已剥离的标注字段)
 * 原样保留,仅替换文件身份并清除共享标记。
 */
async function privatizeSharedAttachment(
  f: AttachedFile,
  sessionId: string,
): Promise<AttachedFile | null> {
  if (!f.url) return null;
  try {
    const meta = await window.electronAPI.cacheMediaForSession({
      url: f.url,
      sessionId,
    });
    return {
      ...f,
      url: meta.url,
      name: meta.name,
      originalName: meta.name,
      ext: meta.ext,
      mimeType: meta.mimeType,
      size: meta.size,
      cacheUrlShared: undefined,
    };
  } catch (err) {
    log.warn('privatizing shared attachment failed, sending as-is', {
      name: f.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Blob → 纯 base64 载荷(去掉 data: 前缀)。 */
export function blobToBase64Payload(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Blob → data: URL。 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
