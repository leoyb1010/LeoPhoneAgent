import { Transform, type TransformCallback } from "node:stream";
import { createInflate, createInflateRaw, type Inflate, type InflateRaw } from "node:zlib";

const DEFLATE_METHOD_MASK = 0x0f;
const DEFLATE_METHOD = 8;

/** 与 fetch 一样兼容历史服务器省略 zlib 包装的 deflate，保持流式背压。 */
export class DeflateDecoder extends Transform {
  private decoder?: Inflate | InflateRaw;

  override _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    if (!chunk.length) { callback(); return; }
    if (!this.decoder) {
      this.decoder = (chunk[0]! & DEFLATE_METHOD_MASK) === DEFLATE_METHOD ? createInflate() : createInflateRaw();
      this.decoder.on("data", (data: Buffer) => {
        if (!this.push(data)) this.decoder!.pause();
      });
      this.decoder.once("error", (error) => this.destroy(error));
    }
    this.decoder.write(chunk, encoding, callback);
  }

  override _read(size: number): void {
    super._read(size);
    this.decoder?.resume();
  }

  override _flush(callback: TransformCallback): void {
    if (!this.decoder) { callback(); return; }
    this.decoder.once("end", callback);
    this.decoder.end();
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.decoder?.destroy();
    callback(error);
  }
}
