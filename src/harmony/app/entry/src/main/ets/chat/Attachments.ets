import { common } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';
import { fileIo } from '@kit.CoreFileKit';
import { image as imageKit } from '@kit.ImageKit';
import { util } from '@kit.ArkTS';
import { PendingImage } from '../local/ChatRun';
import { SessionStore } from '../store/SessionStore';
import { WorkspaceStore } from '../store/WorkspaceStore';

export class PickedFiles {
  names: string[] = [];
  /** 超过 20MB 没带上的个数。 */
  skipped: number = 0;
}

/** 选照片、选文件(聊天页和首页输入框共用)。 */
export class Attachments {
  /** Native photo picker keeps each selected image as a separate removable attachment. */
  static async pickImages(ctx: common.UIAbilityContext, capacity: number = 16): Promise<PendingImage[]> {
    if (capacity <= 0) throw new Error('单条消息最多16张图片');
    const options = new picker.PhotoSelectOptions(); options.MIMEType = picker.PhotoViewMIMETypes.IMAGE_TYPE;
    options.maxSelectNumber = Math.min(16, capacity);
    const chosen = await new picker.PhotoViewPicker().select(options); const out: PendingImage[] = [];
    for (const uri of chosen?.photoUris ?? []) {
      const file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
      try {
        const size = fileIo.statSync(file.fd).size;
        if (size <= 0 || size > 8 * 1024 * 1024) throw new Error('图片为空或超过8MiB，请选择较小图片');
        let buf = new ArrayBuffer(size);
        if (fileIo.readSync(file.fd, buf) !== size) throw new Error('图片读取不完整，本次没有添加');
        let bytes = new Uint8Array(buf); const png = bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
        const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        const source = imageKit.createImageSource(buf);
        try {
          const info = await source.getImageInfo(); if (info.size.width <= 0 || info.size.height <= 0 || info.size.width * info.size.height > 24 * 1024 * 1024) throw new Error('图片像素超过24M限制');
          const decoded = await source.createPixelMap(); await decoded.release();
          if (!png && !jpeg) {
            const packer = imageKit.createImagePacker();
            try { buf = await packer.packing(source, { format: 'image/png', quality: 100 }); } finally { await packer.release(); }
            if (!buf.byteLength || buf.byteLength > 8 * 1024 * 1024) throw new Error('图片转PNG后超过8MiB');
            bytes = new Uint8Array(buf);
          }
        }
        finally { await source.release(); }
        const image = new PendingImage(); image.b64 = new util.Base64Helper().encodeToStringSync(bytes); image.mime = jpeg ? 'image/jpeg' : 'image/png';
        image.path = SessionStore.writeImageBytes(ctx, buf, image.mime); out.push(image);
      } finally { fileIo.closeSync(file); }
    }
    return out;
  }
  static async pickImage(ctx: common.UIAbilityContext): Promise<PendingImage | null> { const images = await Attachments.pickImages(ctx, 1); return images[0] ?? null; }

  /**
   * 选文件:复制进沙箱,消息里只带文件名清单,模型自己用 file_read / read_image 读 ——
   * 和 iOS、安卓一样不把正文塞进消息。单个文件最多 20MB,最多 5 个。
   */
  static async pickFiles(ctx: common.UIAbilityContext, directory: string = ''): Promise<PickedFiles> {
    const out = new PickedFiles();
    const options = new picker.DocumentSelectOptions();
    options.maxSelectNumber = 5;
    const uris = await new picker.DocumentViewPicker(ctx).select(options);
    for (let i = 0; uris && i < uris.length; i++) {
      const file = fileIo.openSync(uris[i], fileIo.OpenMode.READ_ONLY);
      try {
        const size = fileIo.statSync(file.fd).size;
        if (size > 20 * 1024 * 1024) {
          out.skipped += 1;
          continue;
        }
        const buf = new ArrayBuffer(size);
        if (fileIo.readSync(file.fd, buf) !== size) throw new Error('文件读取不完整，本次没有添加');
        const raw = uris[i].substring(uris[i].lastIndexOf('/') + 1);
        let name = raw;
        try {
          name = decodeURIComponent(raw);
        } catch (_err) {
          name = raw;
        }
        out.names.push(WorkspaceStore.saveUpload(ctx, name, buf, directory));
      } finally {
        fileIo.closeSync(file);
      }
    }
    return out;
  }
}
