// [remote-ctl-mac] 手机发消息带图片(docs/specs/leo-link-remote-controls.md「会话操作」)。
// 图片原样走 sendPrompt 的 image 附件(dataBase64,与桌面 ≤20MB 内联图片同一路径);HEIC 内核不认,先用 sips 转 JPEG。
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { ZCodePromptAttachment } from "@zcode/shared";

import type { LinkResponse } from "./bridge.js";
import { error } from "./linkPolicy.js";

export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 4;
const MIME_ALIASES: Record<string, string> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
  "image/heic": "image/heic",
  "image/heif": "image/heic",
};
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic" };
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type HeicConverter = (data: Buffer) => Promise<Buffer>;

/** macOS 自带 sips:HEIC → JPEG。只在临时目录里转,转完就删。 */
export const sipsHeicToJpeg: HeicConverter = async (data) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "leo-link-heic-"));
  try {
    const input = path.join(dir, "in.heic");
    const output = path.join(dir, "out.jpg");
    await writeFile(input, data, { mode: 0o600 });
    await promisify(execFile)("/usr/bin/sips", ["-s", "format", "jpeg", input, "--out", output], { timeout: 30_000 });
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** 没带 attachments → [];格式不对 400、类型不对 415、超数量 / 超大小 413。 */
export async function parseAttachments(
  value: unknown,
  convertHeic: HeicConverter = sipsHeicToJpeg,
): Promise<ZCodePromptAttachment[] | LinkResponse> {
  if (value == null) return [];
  if (!Array.isArray(value)) return error(400, "attachments 必须是数组");
  if (value.length > ATTACHMENT_MAX_COUNT) return error(413, `最多 ${ATTACHMENT_MAX_COUNT} 张图片`);
  const parsed: ZCodePromptAttachment[] = [];
  for (const [index, raw] of value.entries()) {
    const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const mime = MIME_ALIASES[String(item["mime"] ?? "").toLowerCase()];
    if (!mime) return error(415, "只支持 JPEG / PNG / HEIC / WebP 图片");
    const data = typeof item["data_base64"] === "string" ? item["data_base64"].replace(/\s+/g, "") : "";
    if (!data || data.length % 4 !== 0 || !BASE64.test(data)) return error(400, "data_base64 不是有效的 base64");
    // 先按 base64 长度估算,免得超大的正文也先整份解码。
    if ((data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0) > ATTACHMENT_MAX_BYTES)
      return error(413, "每张图片不能超过 5 MB");
    let bytes: Buffer = Buffer.from(data, "base64");
    let mimeType = mime;
    let filename = safeName(item["name"], index, mime);
    if (mime === "image/heic") {
      try {
        bytes = await convertHeic(bytes);
      } catch {
        return error(415, "HEIC 图片在这台 Mac 上转不成 JPEG");
      }
      mimeType = "image/jpeg";
      filename = filename.replace(/\.(heic|heif)$/i, "") + ".jpg";
    }
    parsed.push({ kind: "image", filename, mimeType, sizeBytes: bytes.length, dataBase64: bytes.toString("base64") });
  }
  return parsed;
}

function safeName(value: unknown, index: number, mime: string): string {
  const base = typeof value === "string" ? path.basename(value.trim()).replace(/\p{Cc}/gu, "").slice(0, 120) : "";
  return base || `image-${index + 1}.${EXT[mime] ?? "img"}`;
}
