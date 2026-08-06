/**
 * gzipBase64 — renderer 侧的 gzip + base64 编解码纯工具。
 *
 * 用于 device-link remote-op 的大文本内容压缩(fileBrowserTransport):
 * 控制端压缩 writeFile 内容 / 解压 readFile 返回内容,被控端(desktop main)
 * 用 node:zlib 对接——两端都是标准 gzip 流,天然互操作。
 *
 * 实现只依赖 Web 平台原生能力(CompressionStream / DecompressionStream /
 * TextEncoder / btoa),Electron renderer 与 Node ≥18(vitest node 环境)
 * 都可直接运行,零新依赖。压缩在流内部的后台线程执行,不阻塞渲染。
 */

/** base64 编码分块大小:避免 String.fromCharCode(...huge) 撑爆调用栈。 */
const BASE64_CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pipeThrough(
  input: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const stream = new Blob([input as BlobPart]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** UTF-8 文本 → gzip → base64。 */
export async function gzipTextToBase64(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const gz = await pipeThrough(bytes, new CompressionStream('gzip'));
  return bytesToBase64(gz);
}

/** base64 → gunzip → UTF-8 文本。输入损坏时 reject(调用方兜错)。 */
export async function gunzipBase64ToText(b64: string): Promise<string> {
  const gz = base64ToBytes(b64);
  const bytes = await pipeThrough(gz, new DecompressionStream('gzip'));
  return new TextDecoder().decode(bytes);
}
