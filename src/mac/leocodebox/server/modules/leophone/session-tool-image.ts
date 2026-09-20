/** 工具结果里的 ImageContent，发出去给流水看，不只留给模型。 */

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i;
const MAX_IMAGES = 2;
const MAX_CHARS = 350_000;

export function sessionToolImages(result?: unknown): Array<{ mimeType: string; data: string }> {
  const obj = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  const content = Array.isArray(obj.content) ? obj.content : Array.isArray(result) ? result : [];
  const out: Array<{ mimeType: string; data: string }> = [];
  for (const raw of content) {
    const block = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    if (String(block.type ?? '') !== 'image') continue;
    const mime = String(block.mimeType ?? block.mime ?? '');
    const data = String(block.data ?? '').replace(/\s+/g, '');
    if (!IMAGE_MIME.test(mime) || data.length < 8 || data.length > MAX_CHARS) continue;
    out.push({ mimeType: mime, data });
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}
