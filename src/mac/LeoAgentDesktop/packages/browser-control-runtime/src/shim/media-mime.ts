/**
 * Shim: openclaw/plugin-sdk/media-mime.
 * `detectMime` is only referenced by the dropped `sdk-setup-tools` bridge
 * re-export; it is never called on the dispatcher path. Provide a minimal
 * extension-based detector so the symbol resolves.
 */
export function detectMime(input: { buffer?: Buffer; headerMime?: string; filePath?: string }): string {
  if (input.headerMime) return input.headerMime;
  const ext = input.filePath?.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}
