import { textPages } from './ChatUXPolicy';

export class ShareMessage {
  role: string = '';
  text: string = '';
  images: string[] = [];
  files: string[] = [];
}
export class ShareSegment {
  label: string = '';
  text: string = '';
  images: string[] = [];
}
/** Immutable snapshot of the selected turn, not live model state or raw protocol data. */
export function shareSegments(messages: ShareMessage[]): ShareSegment[] {
  const segments: ShareSegment[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const chunks = textPages(message.text + (message.files.length ? '\n附件：' + message.files.join('、') : ''), 1200);
    for (let index = 0; index < chunks.length; index++) {
      const part = new ShareSegment(); part.label = message.role === 'user' ? '你' : 'LeoBot';
      part.text = chunks[index]; segments.push(part);
    }
    for (const path of message.images) {
      const part = new ShareSegment(); part.label = message.role === 'user' ? '你的图片' : 'LeoBot 的图片';
      part.images = [path]; segments.push(part);
    }
  }
  if (!segments.length) throw new Error('这一轮没有可分享的文字或图片');
  if (segments.length > 80) throw new Error('这一轮过长，请使用导出对话；长图最多生成 80 段，不会截断原文');
  return segments;
}

export class SharePage {
  parts: ShareSegment[] = [];
  height: number = 0;
}
/** Export geometry uses vp, fixed font sizes, and a density-aware physical bitmap budget. */
export class SharePageLayout {
  static readonly width: number = 400;
  static readonly padding: number = 20;
  static readonly gap: number = 14;
  static readonly partGap: number = 8;
  static readonly headerHeight: number = 20;
  static readonly labelHeight: number = 26;
  static readonly imageSize: number = 360;
  static readonly maxSidePixels: number = 4096;
  static readonly maxPixels: number = 4 * 1024 * 1024;
  static readonly maxPages: number = 80;
  static readonly baseHeight: number = 2 * SharePageLayout.padding + SharePageLayout.headerHeight;

  static pageHeight(pixelRatio: number): number {
    if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) throw new Error('无法确定长图像素尺寸');
    const width = Math.ceil(SharePageLayout.width * pixelRatio);
    if (width > SharePageLayout.maxSidePixels) throw new Error('当前显示密度超出长图安全尺寸');
    return Math.floor(Math.min(SharePageLayout.maxSidePixels, Math.floor(SharePageLayout.maxPixels / width)) / pixelRatio);
  }
}

/** Pack measured content into native vertical pages; role changes alone never start a PNG. */
export function groupShareSegments(segments: ShareSegment[], maxHeight: number,
  measureText: (text: string) => number): SharePage[] {
  if (!segments.length || segments.length > SharePageLayout.maxPages) throw new Error('长图内容段无效或超过 80 段上限');
  if (!Number.isFinite(maxHeight) || maxHeight <= SharePageLayout.baseHeight + SharePageLayout.gap + SharePageLayout.labelHeight) {
    throw new Error('当前显示密度无法容纳长图内容');
  }
  const pages: SharePage[] = [];
  let page = new SharePage(); page.height = SharePageLayout.baseHeight;
  const measured = (text: string): number => {
    if (!text) return 0;
    const height = measureText(text);
    if (!Number.isFinite(height) || height <= 0) throw new Error('长图文字测量失败，未截断内容');
    return Math.ceil(height);
  };
  const append = (part: ShareSegment, height: number): void => {
    const occupied = SharePageLayout.gap + height;
    if (SharePageLayout.baseHeight + occupied > maxHeight) throw new Error('内容超出单张长图安全尺寸');
    if (page.parts.length && page.height + occupied > maxHeight) {
      pages.push(page); page = new SharePage(); page.height = SharePageLayout.baseHeight;
    }
    if (pages.length >= SharePageLayout.maxPages) throw new Error('长图超过 80 段安全上限，请导出对话；内容未截断');
    page.parts.push(part); page.height += occupied;
  };
  const textLimit = maxHeight - SharePageLayout.baseHeight - SharePageLayout.gap - SharePageLayout.labelHeight - SharePageLayout.partGap;
  for (const segment of segments) {
    // Each original text chunk is at most 1200 code points; native measurement never sees the whole unbounded turn.
    const points = Array.from(segment.text);
    let offset = 0;
    while (offset < points.length) {
      let count = points.length - offset;
      let height = measured(points.slice(offset).join(''));
      if (height > textLimit) {
        // A newline-heavy chunk may exceed a page despite its character count. Split by measured height, not a guess.
        let low = 0; let high = count;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (measured(points.slice(offset, offset + middle).join('')) <= textLimit) low = middle;
          else high = middle - 1;
        }
        count = low;
        if (!count) throw new Error('单个文字超出长图安全尺寸，未截断内容');
        height = measured(points.slice(offset, offset + count).join(''));
      }
      const part = new ShareSegment(); part.label = segment.label;
      part.text = points.slice(offset, offset + count).join('');
      append(part, SharePageLayout.labelHeight + SharePageLayout.partGap + height);
      offset += count;
    }
    for (const path of segment.images) {
      const part = new ShareSegment(); part.label = segment.label; part.images = [path];
      append(part, SharePageLayout.labelHeight + SharePageLayout.partGap + SharePageLayout.imageSize);
    }
    if (!segment.text && !segment.images.length) {
      const part = new ShareSegment(); part.label = segment.label;
      append(part, SharePageLayout.labelHeight);
    }
  }
  if (page.parts.length) pages.push(page);
  return pages;
}
