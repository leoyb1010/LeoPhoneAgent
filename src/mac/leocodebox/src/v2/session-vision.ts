/** 输入栏里提到的图片路径，发出去要带上像素，不只是字。 */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

export function mimeForSessionImage(file: string): string | null {
  const ext = file.trim().replace(/^.*\./, '').toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return null;
}

export function imagePathsInPrompt(prompt?: string | null): string[] {
  const text = String(prompt ?? '');
  const found: string[] = [];
  const seen = new Set<string>();
  const re = /(?:^|[\s`'"(])((?:~\/|\/|\.\.?\/)?(?:[^\s`'")]+\/)*[^\s`'")]+\.(?:png|jpe?g|gif|webp))\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const raw = String(match[1] ?? '').replace(/[.,;:]+$/, '');
    if (!IMAGE_EXT.test(raw) || seen.has(raw)) continue;
    if (raw.startsWith('http://') || raw.startsWith('https://')) continue;
    seen.add(raw);
    found.push(raw);
  }
  return found;
}

export function canAttachSessionImages(input: { machine?: string | null; prompt?: string | null }): boolean {
  return input.machine === 'local' && imagePathsInPrompt(input.prompt).length > 0;
}
