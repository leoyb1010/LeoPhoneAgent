/**
 * reviewImageExts — 审查面板图片 diff 预览支持的 raster 扩展名 → MIME 映射。
 *
 * 抽到 shared 是因为 main 和 renderer 都要消费同一份清单:
 *  - main/git-review/imageReader.ts: 决定是否读取 blob 并给出 dataUrl 的 MIME
 *  - renderer/.../DiffViewer/ImageDiffPreview.tsx: 决定是否走图片预览分支发起 IPC
 * 两端各自维护会漂移(main 能读但 renderer 不请求,或反之)。
 *
 * SVG 有意排除:它是文本格式,需要单独的 sanitize/沙箱设计后才能以图片形式预览。
 */
export const REVIEW_IMAGE_RASTER_MIME_BY_EXT: ReadonlyMap<string, string> = new Map([
  ['.png', 'image/png'],
  ['.apng', 'image/apng'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.jfif', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
]);
