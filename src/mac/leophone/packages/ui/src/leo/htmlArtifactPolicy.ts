import { HTML_ARTIFACT_MAX_BYTES, buildHtmlArtifactCsp, type FileTextSlice } from "@zcode/shared";

export const LEO_HTML_PREVIEW_LIMIT = HTML_ARTIFACT_MAX_BYTES;
export function isLeoHtmlPath(path: string | undefined): boolean {
  return /\.html?$/i.test(path ?? "");
}

/** 不能执行分页读取的一部分；只有完整、非二进制、有限大小的产物才可预览。 */
export function canPreviewLeoHtmlFile(
  file: Pick<
    FileTextSlice,
    "content" | "offset" | "bytesRead" | "totalBytes" | "truncated" | "isBinary"
  >,
): boolean {
  return (
    !file.isBinary &&
    !file.truncated &&
    file.offset === 0 &&
    file.bytesRead === file.totalBytes &&
    file.totalBytes <= LEO_HTML_PREVIEW_LIMIT &&
    new TextEncoder().encode(file.content).byteLength <= LEO_HTML_PREVIEW_LIMIT
  );
}

export function buildLeoHtmlPreviewDocument(content: string, interactive = false): string {
  const policy = buildHtmlArtifactCsp(interactive);
  // 策略在作者内容前生效；后续meta不能放宽已有策略。桌面frame导航另由Main拦截。
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1">${content}`;
}
