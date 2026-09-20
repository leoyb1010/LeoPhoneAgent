/** 工具结果里的图要能看见，不能只剩一句 Read image file。 */

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i;

export function toolImageDataUrls(images?: unknown): string[] {
  if (!Array.isArray(images)) return [];
  const out: string[] = [];
  for (const raw of images) {
    const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const mime = String(row.mimeType ?? row.mime ?? '');
    const data = String(row.data ?? '').replace(/\s+/g, '');
    if (!IMAGE_MIME.test(mime) || data.length < 8) continue;
    out.push(`data:${mime};base64,${data}`);
    if (out.length >= 2) break;
  }
  return out;
}
