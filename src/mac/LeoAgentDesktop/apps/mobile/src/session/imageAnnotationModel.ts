/**
 * imageAnnotationModel.ts — 图片圈点标注的纯函数层(手机版)。
 * ---------------------------------------------------------------------------
 * 与桌面版 lightboxAnnotations.ts(PR #792)同构:笔迹一律存**归一化坐标**
 * (0..1,相对图片自然尺寸),显示(SVG overlay)与烧录(WebView canvas)共用
 * 同一映射,所见即所得。视觉参数(红 #FF3B30 + 白描边、线宽 0.5% 短边)与
 * 桌面完全一致,保证同一张标注图在两端观感一致。
 *
 * 手机版特有的部分:
 *   - contain 布局计算(RN 没有 getBoundingClientRect,显示矩形要从容器尺寸、
 *     自然尺寸与 lightbox 的 translate/scale 状态推导);
 *   - WebView 烧录 HTML 生成(RN 无 DOM canvas,烧录在隐藏 WebView 里重放,
 *     算法与桌面 drawStrokesOnCanvas 逐行对应)。
 * 全部无副作用,node 可单测;React 组件只做事件采集与状态管理。
 */

/** 一条手绘笔迹:归一化坐标点序列(0..1,相对图片自然尺寸)。 */
export interface AnnotationStroke {
  points: Array<{ x: number; y: number }>;
}

/** 标注笔迹主色(红,语义豁免色系;与桌面 ANNOTATION_STROKE_COLOR 一致)。 */
export const ANNOTATION_STROKE_COLOR = '#FF3B30';
export const ANNOTATION_OUTLINE_COLOR = 'rgba(255,255,255,0.9)';

/** 白描边相对红线的宽度倍率(桌面同值)。 */
export const ANNOTATION_OUTLINE_WIDTH_RATIO = 1.8;
/** 采集时的最小点距(归一化):小于该距离的 move 点丢弃,抑制点数爆炸。 */
export const MIN_POINT_DISTANCE_RATIO = 0.002;

/**
 * 烧录 canvas 的边长上限:iOS WKWebView 的 canvas 有约 16MP 的硬限制,超限
 * 绘制静默产出空图。超大图按比例缩到该上限内烧录(归一化笔迹对缩放无感;
 * 发送链路本就有 2048 降采样,此处只是烧录阶段的安全钳)。
 */
export const ANNOTATION_MAX_BURN_DIMENSION = 4096;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** 图片显示矩形(容器坐标系,px)。 */
export interface AnnotationDisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * contain 适配的基础矩形(1x、无平移):图片按 aspect fit 居中放进容器后的
 * 位置与尺寸。lightbox 的 SVG overlay 以它为锚(其中心恒等于容器中心,因此
 * 与图片层共用同一 translate/scale transform 时视觉完全跟随)。
 */
export function annotationBaseRect(
  containerWidth: number,
  containerHeight: number,
  naturalWidth: number,
  naturalHeight: number,
): AnnotationDisplayRect | null {
  if (containerWidth <= 0 || containerHeight <= 0 || naturalWidth <= 0 || naturalHeight <= 0) {
    return null;
  }
  const scale = Math.min(containerWidth / naturalWidth, containerHeight / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return {
    left: (containerWidth - width) / 2,
    top: (containerHeight - height) / 2,
    width,
    height,
  };
}

/**
 * lightbox 变换状态下的实际显示矩形。图片层的 transform 是
 * [translate → scale(围绕容器中心)],因此显示中心 = 容器中心 + 平移量,
 * 尺寸 = 基础矩形 × scale。
 */
export function annotationDisplayRect(
  base: AnnotationDisplayRect,
  containerWidth: number,
  containerHeight: number,
  translateX: number,
  translateY: number,
  scale: number,
): AnnotationDisplayRect {
  const width = base.width * scale;
  const height = base.height * scale;
  return {
    left: containerWidth / 2 + translateX - width / 2,
    top: containerHeight / 2 + translateY - height / 2,
    width,
    height,
  };
}

/**
 * 触点(容器坐标)→ 归一化图片坐标。越界点钳制到边缘(画到图外时贴边),
 * 与桌面 normalizePoint 语义一致。
 */
export function normalizeAnnotationPoint(
  pointX: number,
  pointY: number,
  rect: AnnotationDisplayRect,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: clamp01((pointX - rect.left) / rect.width),
    y: clamp01((pointY - rect.top) / rect.height),
  };
}

/**
 * 是否应把新点追加进笔迹:与上一点距离(归一化)超过阈值才收,
 * 抑制高频 touch move 造成的点数爆炸。首点恒收。
 */
export function shouldAppendAnnotationPoint(
  stroke: AnnotationStroke,
  point: { x: number; y: number },
  minDistance = MIN_POINT_DISTANCE_RATIO,
): boolean {
  const last = stroke.points[stroke.points.length - 1];
  if (!last) return true;
  return Math.hypot(point.x - last.x, point.y - last.y) >= minDistance;
}

/**
 * 烧录/显示用线宽(像素,相对图片自然尺寸):0.5% 短边,4px 下限、24px 上限。
 * 与桌面 annotationStrokeWidth 同公式。
 */
export function annotationStrokeWidth(naturalWidth: number, naturalHeight: number): number {
  const base = Math.min(naturalWidth, naturalHeight) * 0.005;
  return Math.min(24, Math.max(4, Math.round(base)));
}

/**
 * 归一化笔迹 → SVG path `d`(映射到 width×height 像素空间)。
 * 单点笔迹(点按)画一个极短线段,配合 round linecap 呈现为圆点。
 */
export function annotationStrokeToSvgPath(
  stroke: AnnotationStroke,
  width: number,
  height: number,
): string {
  const pts = stroke.points;
  if (pts.length === 0) return '';
  const fmt = (p: { x: number; y: number }) =>
    `${(p.x * width).toFixed(1)} ${(p.y * height).toFixed(1)}`;
  if (pts.length === 1) {
    const x = pts[0].x * width;
    const y = pts[0].y * height;
    return `M ${x.toFixed(1)} ${y.toFixed(1)} L ${(x + 0.1).toFixed(1)} ${y.toFixed(1)}`;
  }
  return `M ${fmt(pts[0])} ${pts.slice(1).map((p) => `L ${fmt(p)}`).join(' ')}`;
}

/** 烧录任务输入(RN → WebView)。 */
export interface AnnotationBurnInRequest {
  /** 任务 id,回包按它对账(host 串行处理,防错帧)。 */
  id: string;
  /** 原图字节(纯 base64,无 data: 前缀)。 */
  base64: string;
  mimeType: string;
  strokes: readonly AnnotationStroke[];
}

/** 烧录回包(WebView → RN,JSON 字符串经 postMessage)。 */
export type AnnotationBurnInResponse =
  | { id: string; ok: true; base64: string; mimeType: string; width: number; height: number }
  | { id: string; ok: false; error: string }
  | { ready: true };

/** 解析 WebView 回包;非本协议消息返回 null(防第三方注入噪声)。 */
export function parseAnnotationBurnInMessage(raw: string): AnnotationBurnInResponse | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const msg = parsed as Record<string, unknown>;
    if (msg.ready === true) return { ready: true };
    if (typeof msg.id !== 'string') return null;
    if (msg.ok === true) {
      if (typeof msg.base64 !== 'string' || typeof msg.mimeType !== 'string') return null;
      return {
        id: msg.id,
        ok: true,
        base64: msg.base64,
        mimeType: msg.mimeType,
        width: typeof msg.width === 'number' ? msg.width : 0,
        height: typeof msg.height === 'number' ? msg.height : 0,
      };
    }
    if (msg.ok === false) {
      return { id: msg.id, ok: false, error: typeof msg.error === 'string' ? msg.error : 'unknown' };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 构造注入 WebView 的烧录调用语句。请求经 JSON.stringify 嵌入:base64 字符集
 * 与数字坐标不含 `</script>` / 引号逃逸风险,注入安全。
 */
export function buildAnnotationBurnInInvocation(request: AnnotationBurnInRequest): string {
  return `window.__xdtBurnIn(${JSON.stringify(request)}); true;`;
}

/**
 * 烧录 WebView 的宿主 HTML。canvas 重放算法与桌面 drawStrokesOnCanvas 逐行
 * 对应:round cap/join、两遍绘制(先全部白描边、再全部红线,保证交叉处不出现
 * 白边压红线的断裂),单点画极短线段呈圆点。JPEG 源保持 JPEG(照片转 PNG 体积
 * 爆炸),其余输出 PNG。
 */
export function buildAnnotationBurnInHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body>
<script>
(function () {
  'use strict';
  var STROKE_COLOR = ${JSON.stringify(ANNOTATION_STROKE_COLOR)};
  var OUTLINE_COLOR = ${JSON.stringify(ANNOTATION_OUTLINE_COLOR)};
  var OUTLINE_RATIO = ${ANNOTATION_OUTLINE_WIDTH_RATIO};
  var MAX_DIMENSION = ${ANNOTATION_MAX_BURN_DIMENSION};

  function post(msg) {
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }

  function strokeWidthFor(width, height) {
    var base = Math.min(width, height) * 0.005;
    return Math.min(24, Math.max(4, Math.round(base)));
  }

  function drawPass(ctx, strokes, width, height, color, lineWidth) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    for (var s = 0; s < strokes.length; s++) {
      var pts = strokes[s].points;
      if (!pts || pts.length === 0) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0].x * width, pts[0].y * height);
      if (pts.length === 1) {
        ctx.lineTo(pts[0].x * width + 0.1, pts[0].y * height);
      } else {
        for (var i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i].x * width, pts[i].y * height);
        }
      }
      ctx.stroke();
    }
  }

  window.__xdtBurnIn = function (request) {
    try {
      var img = new Image();
      img.onload = function () {
        try {
          var naturalWidth = img.naturalWidth || img.width;
          var naturalHeight = img.naturalHeight || img.height;
          if (!naturalWidth || !naturalHeight) {
            post({ id: request.id, ok: false, error: 'image has no dimensions' });
            return;
          }
          var cap = Math.min(1, MAX_DIMENSION / Math.max(naturalWidth, naturalHeight));
          var width = Math.max(1, Math.round(naturalWidth * cap));
          var height = Math.max(1, Math.round(naturalHeight * cap));
          var canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          var ctx = canvas.getContext('2d');
          if (!ctx) {
            post({ id: request.id, ok: false, error: 'canvas unavailable' });
            return;
          }
          ctx.drawImage(img, 0, 0, width, height);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          var strokeWidth = strokeWidthFor(width, height);
          drawPass(ctx, request.strokes, width, height, OUTLINE_COLOR, Math.round(strokeWidth * OUTLINE_RATIO));
          drawPass(ctx, request.strokes, width, height, STROKE_COLOR, strokeWidth);
          var outMime = request.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
          var dataUrl = canvas.toDataURL(outMime, 0.92);
          var comma = dataUrl.indexOf(',');
          if (comma < 0) {
            post({ id: request.id, ok: false, error: 'encode failed' });
            return;
          }
          post({
            id: request.id,
            ok: true,
            base64: dataUrl.slice(comma + 1),
            mimeType: outMime,
            width: width,
            height: height,
          });
        } catch (err) {
          post({ id: request.id, ok: false, error: String(err) });
        }
      };
      img.onerror = function () {
        post({ id: request.id, ok: false, error: 'image decode failed' });
      };
      img.src = 'data:' + request.mimeType + ';base64,' + request.base64;
    } catch (err) {
      post({ id: request.id, ok: false, error: String(err) });
    }
  };

  post({ ready: true });
})();
</script>
</body></html>`;
}

/** 标注产物的文件名(烧录图始终是新文件,不覆盖原图)。 */
export function annotationBurnedFileName(mimeType: string, nowMs: number): string {
  const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
  return `annotated-${nowMs}.${ext}`;
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 头部 → 字节(只解码给魔数嗅探用的前几字节;不依赖全局 atob)。 */
function decodeBase64Head(base64: string, byteCount: number): Uint8Array {
  const charCount = Math.ceil(byteCount / 3) * 4;
  const clean = base64.slice(0, charCount).replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(byteCount);
  let outIndex = 0;
  for (let i = 0; i + 3 < clean.length + 1 && outIndex < byteCount; i += 4) {
    const e1 = BASE64_CHARS.indexOf(clean.charAt(i));
    const e2 = BASE64_CHARS.indexOf(clean.charAt(i + 1));
    const e3 = BASE64_CHARS.indexOf(clean.charAt(i + 2));
    const e4 = BASE64_CHARS.indexOf(clean.charAt(i + 3));
    if (e1 < 0 || e2 < 0) break;
    out[outIndex++] = (e1 << 2) | (e2 >> 4);
    if (e3 >= 0 && outIndex < byteCount) out[outIndex++] = ((e2 & 15) << 4) | (e3 >> 2);
    if (e4 >= 0 && outIndex < byteCount) out[outIndex++] = ((e3 & 3) << 6) | e4;
  }
  return out.slice(0, outIndex);
}

/**
 * 按字节魔数嗅探图片 mime(png/jpeg/gif/webp;识别不出返回 null)。
 * 与桌面 lightboxMediaActions.sniffImageMime 同口径(PR #792 review P2):
 * http 源的扩展名 / Content-Type 都可能缺失或说谎,mime 以字节为准,
 * 避免 JPEG 字节标成 .png 造成扩展名与内容不符。
 */
export function sniffImageMimeFromBase64(base64: string): string | null {
  const b = decodeBase64Head(base64, 12);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return 'image/png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return 'image/jpeg';
  }
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return 'image/gif'; // GIF8
  }
  if (
    b.length >= 12
    && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 // RIFF
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // WEBP
  ) {
    return 'image/webp';
  }
  return null;
}

/** 乐观上传管线直传白名单(与 attachments SUPPORTED_IMAGE_EXTS 同口径)。
 *  不在名单的可显示格式(bmp/ico/heic 等)转发时走烧录通道光栅化为 PNG
 *  (对齐桌面「字节可达 + 发送时光栅化」模型,PR #792)。 */
export function isDirectSendableImageMime(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();
  return lower === 'image/png' || lower === 'image/jpeg' || lower === 'image/gif' || lower === 'image/webp';
}

/**
 * 图源 uri 的 mime 兜底(魔数嗅探失败时用):按扩展名返回**真实** mime,
 * 未知扩展给 application/octet-stream。绝不默认 image/jpeg——bmp/heic/avif/svg
 * 被标成 jpeg 会把「必须光栅化」的源误判为可直传,unsupported 字节顶着 .jpg
 * 上传(review P1);非直传 mime 会让这些源正确落入烧录光栅化路径,解不出时
 * 也是明确失败(Alert)而非静默坏数据。
 */
export function imageMimeForUriFallback(uri: string): string {
  const clean = (uri.split(/[?#]/)[0] ?? uri).toLowerCase();
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.gif')) return 'image/gif';
  if (clean.endsWith('.bmp')) return 'image/bmp';
  if (clean.endsWith('.heic')) return 'image/heic';
  if (clean.endsWith('.heif')) return 'image/heif';
  if (clean.endsWith('.avif')) return 'image/avif';
  if (clean.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

/** gif(动图烧录只留首帧)与非位图源不开放画笔。 */
export function canAnnotateImageMime(mimeType: string | undefined): boolean {
  if (!mimeType) return true;
  const lower = mimeType.toLowerCase();
  if (!lower.startsWith('image/')) return false;
  return lower !== 'image/gif' && lower !== 'image/svg+xml';
}
