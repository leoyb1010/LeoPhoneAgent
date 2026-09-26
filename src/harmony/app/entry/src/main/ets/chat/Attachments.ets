import { common } from '@kit.AbilityKit';
import { picker } from '@kit.CoreFileKit';
import { fileIo } from '@kit.CoreFileKit';
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
  /** 选一张照片;取消返回 null。超过 4MB 明说,不发半张图(原来只读前 4MB,得到一张截断的 JPEG)。 */
  static async pickImage(ctx: common.UIAbilityContext): Promise<PendingImage | null> {
    const options = new picker.PhotoSelectOptions();
    options.MIMEType = picker.PhotoViewMIMETypes.IMAGE_TYPE;
    options.maxSelectNumber = 1;
    const chosen = await new picker.PhotoViewPicker().select(options);
    if (!chosen || !chosen.photoUris || chosen.photoUris.length === 0) {
      return null;
    }
    const uri = chosen.photoUris[0];
    const file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    try {
      const stat = fileIo.statSync(file.fd);
      if (stat.size > 4 * 1024 * 1024) {
        throw new Error('这张图超过 4MB，换一张小的');
      }
      const buf = new ArrayBuffer(stat.size);
      fileIo.readSync(file.fd, buf);
      const image = new PendingImage();
      image.b64 = new util.Base64Helper().encodeToStringSync(new Uint8Array(buf));
      image.mime = uri.toLowerCase().indexOf('.png') >= 0 ? 'image/png' : 'image/jpeg';
      image.path = SessionStore.writeImageBytes(ctx, buf, image.mime);
      return image;
    } finally {
      fileIo.closeSync(file);
    }
  }

  /**
   * 选文件:复制进沙箱,消息里只带文件名清单,模型自己用 file_read / read_image 读 ——
   * 和 iOS、安卓一样不把正文塞进消息。单个文件最多 20MB,最多 5 个。
   */
  static async pickFiles(ctx: common.UIAbilityContext): Promise<PickedFiles> {
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
        fileIo.readSync(file.fd, buf);
        const raw = uris[i].substring(uris[i].lastIndexOf('/') + 1);
        let name = raw;
        try {
          name = decodeURIComponent(raw);
        } catch (_err) {
          name = raw;
        }
        out.names.push(WorkspaceStore.saveUpload(ctx, name, buf));
      } finally {
        fileIo.closeSync(file);
      }
    }
    return out;
  }
}
