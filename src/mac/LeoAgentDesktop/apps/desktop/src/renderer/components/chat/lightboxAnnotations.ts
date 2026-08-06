/**
 * lightboxAnnotations — 图片 lightbox 标注模式的纯函数层。
 *
 * 职责:笔迹坐标归一化、SVG path 构造、相对线宽计算、canvas 烧录重放。
 * 全部无副作用,React 组件(ImageLightbox)只做事件采集与状态管理。
 *
 * 坐标系约定:笔迹点一律存**归一化坐标**(0..1,相对图片自然尺寸)。
 * - 采集:屏幕坐标 ÷ 图片元素的 getBoundingClientRect(rect 已含 CSS transform,
 *   因此缩放/平移状态下画的笔迹无需手动逆变换)。
 * - 显示:SVG overlay 的 viewBox 即图片自然尺寸,归一化点 × 自然尺寸 = path 坐标,
 *   与烧录坐标完全一致(所见即所得,线宽也一致)。
 * - 烧录:canvas 以自然尺寸绘制原图后按同一映射重放笔迹。
 */

import type { ImageAnnotationStroke } from '@/lib/fileTypes';

/** 一条手绘笔迹:归一化坐标点序列(0..1,相对图片自然尺寸)。 */
export type AnnotationStroke = ImageAnnotationStroke;

/** 标注笔迹主色(红,与语义豁免色同族;白描边保证深色/红色背景上仍醒目)。 */
export const ANNOTATION_STROKE_COLOR = '#FF3B30';
export const ANNOTATION_OUTLINE_COLOR = 'rgba(255,255,255,0.9)';

/** 白描边相对红线的宽度倍率。 */
const OUTLINE_WIDTH_RATIO = 1.8;
/** 采集时的最小点距(归一化):小于该距离的 move 点丢弃,抑制点数爆炸。 */
export const MIN_POINT_DISTANCE_RATIO = 0.002;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * 屏幕坐标 → 归一化图片坐标。`rect` 传图片元素的 getBoundingClientRect()
 * (已含 transform 后的实际显示矩形)。越界点钳制到边缘(画到图外时贴边)。
 */
export function normalizePoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: clamp01((clientX - rect.left) / rect.width),
    y: clamp01((clientY - rect.top) / rect.height),
  };
}

/**
 * 是否应把新点追加进笔迹:与上一点距离(归一化)超过阈值才收,
 * 抑制高频 mousemove 造成的点数爆炸。首点恒收。
 */
export function shouldAppendPoint(
  stroke: AnnotationStroke,
  point: { x: number; y: number },
  minDistance = MIN_POINT_DISTANCE_RATIO,
): boolean {
  const last = stroke.points[stroke.points.length - 1];
  if (!last) return true;
  const dx = point.x - last.x;
  const dy = point.y - last.y;
  return Math.hypot(dx, dy) >= minDistance;
}

/**
 * 烧录/显示用线宽(像素,相对图片自然尺寸):大图上足够醒目、小图上不糊脸。
 * 0.5% 短边,4px 下限、24px 上限。
 */
export function annotationStrokeWidth(naturalWidth: number, naturalHeight: number): number {
  const base = Math.min(naturalWidth, naturalHeight) * 0.005;
  return Math.min(24, Math.max(4, Math.round(base)));
}

/**
 * 归一化笔迹 → SVG path `d`(映射到 width×height 像素空间)。
 * 单点笔迹(点按)画一个极短线段,配合 round linecap 呈现为圆点。
 */
export function strokeToSvgPath(
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

/** canvas 2D context 中烧录所需的最小接口(便于单测注入 fake)。 */
export interface StrokeCanvasContext {
  lineCap: string;
  lineJoin: string;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

/**
 * 把笔迹重放到 canvas context(width×height 为图片自然尺寸)。
 * 两遍绘制:先全部白描边、再全部红线——保证笔迹交叉处不会出现
 * 白边盖住相邻红线的断裂感。
 */
export function drawStrokesOnCanvas(
  ctx: StrokeCanvasContext,
  strokes: readonly AnnotationStroke[],
  width: number,
  height: number,
): void {
  const strokeWidth = annotationStrokeWidth(width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const drawPass = (color: string, lineWidth: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    for (const stroke of strokes) {
      const pts = stroke.points;
      if (pts.length === 0) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0].x * width, pts[0].y * height);
      if (pts.length === 1) {
        // 单点:极短线段 + round cap = 圆点,与 SVG 显示一致。
        ctx.lineTo(pts[0].x * width + 0.1, pts[0].y * height);
      } else {
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i].x * width, pts[i].y * height);
        }
      }
      ctx.stroke();
    }
  };

  drawPass(ANNOTATION_OUTLINE_COLOR, Math.round(strokeWidth * OUTLINE_WIDTH_RATIO));
  drawPass(ANNOTATION_STROKE_COLOR, strokeWidth);
}
