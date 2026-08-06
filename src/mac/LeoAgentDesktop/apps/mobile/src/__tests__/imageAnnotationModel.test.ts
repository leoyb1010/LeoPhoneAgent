import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_MAX_BURN_DIMENSION,
  ANNOTATION_OUTLINE_COLOR,
  ANNOTATION_STROKE_COLOR,
  annotationBaseRect,
  annotationBurnedFileName,
  annotationDisplayRect,
  annotationStrokeToSvgPath,
  annotationStrokeWidth,
  buildAnnotationBurnInHtml,
  buildAnnotationBurnInInvocation,
  canAnnotateImageMime,
  imageMimeForUriFallback,
  isDirectSendableImageMime,
  normalizeAnnotationPoint,
  parseAnnotationBurnInMessage,
  shouldAppendAnnotationPoint,
  sniffImageMimeFromBase64,
} from '@/session/imageAnnotationModel';

describe('annotationBaseRect(contain 布局)', () => {
  it('横图:宽占满,垂直居中', () => {
    // 容器 400x800,图 2000x1000 → fit 比例 0.2 → 400x200,top=(800-200)/2
    expect(annotationBaseRect(400, 800, 2000, 1000)).toEqual({
      left: 0,
      top: 300,
      width: 400,
      height: 200,
    });
  });

  it('竖图:高占满,水平居中', () => {
    expect(annotationBaseRect(400, 800, 500, 1000)).toEqual({
      left: 0,
      top: 0,
      width: 400,
      height: 800,
    });
  });

  it('非法尺寸返回 null', () => {
    expect(annotationBaseRect(0, 800, 100, 100)).toBeNull();
    expect(annotationBaseRect(400, 800, 0, 100)).toBeNull();
  });
});

describe('annotationDisplayRect(transform 后的显示矩形)', () => {
  const base = { left: 0, top: 300, width: 400, height: 200 };

  it('1x 无平移 = 基础矩形', () => {
    expect(annotationDisplayRect(base, 400, 800, 0, 0, 1)).toEqual(base);
  });

  it('缩放围绕容器中心:尺寸 × scale,中心随平移偏移', () => {
    const rect = annotationDisplayRect(base, 400, 800, 40, -30, 2);
    expect(rect.width).toBe(800);
    expect(rect.height).toBe(400);
    // 中心 = (200+40, 400-30) → left = 240-400, top = 370-200
    expect(rect.left).toBe(-160);
    expect(rect.top).toBe(170);
  });
});

describe('normalizeAnnotationPoint', () => {
  const rect = { left: 100, top: 200, width: 200, height: 100 };

  it('矩形内的点按比例归一化', () => {
    expect(normalizeAnnotationPoint(200, 250, rect)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('越界点钳制到边缘(画到图外时贴边)', () => {
    expect(normalizeAnnotationPoint(0, 0, rect)).toEqual({ x: 0, y: 0 });
    expect(normalizeAnnotationPoint(1000, 1000, rect)).toEqual({ x: 1, y: 1 });
  });

  it('零尺寸矩形返回 null', () => {
    expect(normalizeAnnotationPoint(1, 1, { left: 0, top: 0, width: 0, height: 100 })).toBeNull();
  });
});

describe('shouldAppendAnnotationPoint(点距抑制)', () => {
  it('首点恒收', () => {
    expect(shouldAppendAnnotationPoint({ points: [] }, { x: 0.5, y: 0.5 })).toBe(true);
  });

  it('距上一点过近的 move 点丢弃,超过阈值才收', () => {
    const stroke = { points: [{ x: 0.5, y: 0.5 }] };
    expect(shouldAppendAnnotationPoint(stroke, { x: 0.5001, y: 0.5 })).toBe(false);
    expect(shouldAppendAnnotationPoint(stroke, { x: 0.51, y: 0.5 })).toBe(true);
  });
});

describe('annotationStrokeWidth(与桌面同公式:0.5% 短边,4~24px)', () => {
  it('小图走下限、大图走上限、中等图按比例', () => {
    expect(annotationStrokeWidth(200, 200)).toBe(4);
    expect(annotationStrokeWidth(10000, 10000)).toBe(24);
    expect(annotationStrokeWidth(2000, 3000)).toBe(10);
  });
});

describe('annotationStrokeToSvgPath', () => {
  it('空笔迹返回空串', () => {
    expect(annotationStrokeToSvgPath({ points: [] }, 100, 100)).toBe('');
  });

  it('单点画极短线段(round cap 呈圆点)', () => {
    const d = annotationStrokeToSvgPath({ points: [{ x: 0.5, y: 0.5 }] }, 100, 100);
    expect(d).toBe('M 50.0 50.0 L 50.1 50.0');
  });

  it('多点连线映射到像素空间', () => {
    const d = annotationStrokeToSvgPath(
      { points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }] },
      200,
      100,
    );
    expect(d).toBe('M 0.0 0.0 L 100.0 50.0 L 200.0 100.0');
  });
});

describe('烧录 WebView 协议', () => {
  it('HTML 内嵌与模型层一致的视觉参数与安全钳', () => {
    const html = buildAnnotationBurnInHtml();
    expect(html).toContain(ANNOTATION_STROKE_COLOR);
    expect(html).toContain(ANNOTATION_OUTLINE_COLOR);
    expect(html).toContain(String(ANNOTATION_MAX_BURN_DIMENSION));
    expect(html).toContain('window.__xdtBurnIn');
    // 回包协议字段
    expect(html).toContain('ready: true');
  });

  it('invocation 把请求 JSON 内联进调用语句', () => {
    const call = buildAnnotationBurnInInvocation({
      id: 'burn-1',
      base64: 'QUJD',
      mimeType: 'image/png',
      strokes: [{ points: [{ x: 0.1, y: 0.2 }] }],
    });
    expect(call.startsWith('window.__xdtBurnIn({')).toBe(true);
    expect(call).toContain('"id":"burn-1"');
    expect(call).toContain('"base64":"QUJD"');
    expect(call.endsWith('true;')).toBe(true);
  });

  it('parse:ready / 成功 / 失败回包与噪声', () => {
    expect(parseAnnotationBurnInMessage(JSON.stringify({ ready: true }))).toEqual({ ready: true });
    expect(parseAnnotationBurnInMessage(JSON.stringify({
      id: 'burn-2',
      ok: true,
      base64: 'eHl6',
      mimeType: 'image/jpeg',
      width: 10,
      height: 20,
    }))).toEqual({ id: 'burn-2', ok: true, base64: 'eHl6', mimeType: 'image/jpeg', width: 10, height: 20 });
    expect(parseAnnotationBurnInMessage(JSON.stringify({ id: 'burn-3', ok: false, error: 'x' })))
      .toEqual({ id: 'burn-3', ok: false, error: 'x' });
    // 非本协议消息(第三方注入 / 乱码)一律 null
    expect(parseAnnotationBurnInMessage('not-json')).toBeNull();
    expect(parseAnnotationBurnInMessage(JSON.stringify({ foo: 1 }))).toBeNull();
    expect(parseAnnotationBurnInMessage(JSON.stringify({ id: 'x', ok: true }))).toBeNull();
  });
});

describe('sniffImageMimeFromBase64(字节魔数,与桌面 sniffImageMime 同口径)', () => {
  const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');

  it('识别 png / jpeg / gif / webp 魔数', () => {
    expect(sniffImageMimeFromBase64(b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])))
      .toBe('image/png');
    expect(sniffImageMimeFromBase64(b64([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])))
      .toBe('image/jpeg');
    expect(sniffImageMimeFromBase64(b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])))
      .toBe('image/gif'); // GIF89a
    expect(sniffImageMimeFromBase64(b64([
      0x52, 0x49, 0x46, 0x46, 0x11, 0x22, 0x33, 0x44, 0x57, 0x45, 0x42, 0x50,
    ]))).toBe('image/webp'); // RIFF....WEBP
  });

  it('识别不出返回 null(bmp / 文本 / 空串)', () => {
    expect(sniffImageMimeFromBase64(b64([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0]))).toBeNull(); // BM
    expect(sniffImageMimeFromBase64(Buffer.from('hello world!').toString('base64'))).toBeNull();
    expect(sniffImageMimeFromBase64('')).toBeNull();
  });
});

describe('isDirectSendableImageMime(直传白名单;名单外走光栅化)', () => {
  it('四格式直传,bmp / heic / svg 走烧录光栅化', () => {
    expect(isDirectSendableImageMime('image/png')).toBe(true);
    expect(isDirectSendableImageMime('image/jpeg')).toBe(true);
    expect(isDirectSendableImageMime('image/gif')).toBe(true);
    expect(isDirectSendableImageMime('image/webp')).toBe(true);
    expect(isDirectSendableImageMime('image/bmp')).toBe(false);
    expect(isDirectSendableImageMime('image/heic')).toBe(false);
    expect(isDirectSendableImageMime('image/svg+xml')).toBe(false);
  });
});

describe('imageMimeForUriFallback(嗅探失败的扩展名兜底)', () => {
  it('已知扩展返回真实 mime(含查询串)', () => {
    expect(imageMimeForUriFallback('file:///a/b.PNG')).toBe('image/png');
    expect(imageMimeForUriFallback('https://x/y.jpg?sig=1')).toBe('image/jpeg');
    expect(imageMimeForUriFallback('file:///a/b.heic')).toBe('image/heic');
    expect(imageMimeForUriFallback('file:///a/b.bmp')).toBe('image/bmp');
    expect(imageMimeForUriFallback('file:///a/b.svg')).toBe('image/svg+xml');
  });

  it('绝不默认 image/jpeg:未知扩展 / 无扩展给非直传 mime,落入光栅化路径(review P1)', () => {
    const unknown = imageMimeForUriFallback('https://oss/presigned-no-ext');
    expect(unknown).toBe('application/octet-stream');
    expect(isDirectSendableImageMime(unknown)).toBe(false);
    expect(isDirectSendableImageMime(imageMimeForUriFallback('file:///a/b.heic'))).toBe(false);
  });
});

describe('annotationBurnedFileName / canAnnotateImageMime', () => {
  it('jpeg 保 jpg 扩展,其余 png', () => {
    expect(annotationBurnedFileName('image/jpeg', 123)).toBe('annotated-123.jpg');
    expect(annotationBurnedFileName('image/png', 123)).toBe('annotated-123.png');
    expect(annotationBurnedFileName('image/webp', 123)).toBe('annotated-123.png');
  });

  it('gif / svg / 非图片不开放画笔;未知 mime 放行(由 uri 后缀兜底)', () => {
    expect(canAnnotateImageMime('image/gif')).toBe(false);
    expect(canAnnotateImageMime('image/svg+xml')).toBe(false);
    expect(canAnnotateImageMime('video/mp4')).toBe(false);
    expect(canAnnotateImageMime('image/png')).toBe(true);
    expect(canAnnotateImageMime('image/jpeg')).toBe(true);
    expect(canAnnotateImageMime(undefined)).toBe(true);
  });
});
