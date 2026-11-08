import { common } from '@kit.AbilityKit';
import { fileIo, picker } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { AtomicTextFile } from '../store/AtomicFile';
import { BrainAPI, BrainJSON, text, items } from './BrainAPI';

export class BrainUploadJob {
  id: string = '';
  name: string = '';
  generation: string = '';
  uploadId: string = '';
  size: number = 0;
  received: number = 0;
  stage: string = '待上传';
  fileId: string = '';
}

/** Durable local copies retain picker access across process death. Server offset is authoritative. */
export class BrainUpload {
  jobs: BrainUploadJob[] = [];
  private root: string = '';
  private file: AtomicTextFile = new AtomicTextFile();
  private running: boolean = false;
  load(context: common.UIAbilityContext): void {
    this.root = context.filesDir + '/brain-uploads';
    if (!fileIo.accessSync(this.root)) fileIo.mkdirSync(this.root);
    const raw = this.file.read(this.root + '/jobs.json');
    this.jobs = raw ? JSON.parse(raw) as BrainUploadJob[] : [];
  }
  private save(): void { this.file.write(this.root + '/jobs.json', JSON.stringify(this.jobs)); }
  async pick(context: common.UIAbilityContext, photo: boolean): Promise<void> {
    let uris: string[] = [];
    if (photo) {
      const options = new picker.PhotoSelectOptions();
      options.MIMEType = picker.PhotoViewMIMETypes.IMAGE_VIDEO_TYPE;
      options.maxSelectNumber = 12;
      uris = (await new picker.PhotoViewPicker().select(options)).photoUris;
    } else {
      const options = new picker.DocumentSelectOptions();
      options.maxSelectNumber = 5;
      uris = await new picker.DocumentViewPicker(context).select(options);
    }
    for (const uri of uris) {
      const job = new BrainUploadJob();
      job.id = util.generateRandomUUID(false);
      job.generation = BrainAPI.generation();
      job.name = decodeURIComponent(uri.substring(uri.lastIndexOf('/') + 1)).replace(/[\x00-\x1f/\\]/g, '_');
      const source = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
      try {
        job.size = fileIo.statSync(source.fd).size;
        if (!Number.isSafeInteger(job.size) || job.size <= 0) throw new Error('文件为空或大小无效');
        const target = fileIo.openSync(this.root + '/' + job.id, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC | fileIo.OpenMode.NOFOLLOW);
        try {
          const buffer = new ArrayBuffer(1024 * 1024);
          let offset = 0;
          while (offset < job.size) {
            const length = fileIo.readSync(source.fd, buffer, { length: Math.min(buffer.byteLength, job.size - offset) });
            if (length <= 0 || fileIo.writeSync(target.fd, buffer, { length: length }) !== length) throw new Error('文件复制中断');
            offset += length;
          }
          fileIo.fsyncSync(target.fd);
        } finally { fileIo.closeSync(target); }
      } catch (error) {
        if (fileIo.accessSync(this.root + '/' + job.id)) fileIo.unlinkSync(this.root + '/' + job.id);
        throw error as Error;
      } finally { fileIo.closeSync(source); }
      this.jobs.push(job);
      this.save();
    }
  }
  async run(job: BrainUploadJob, changed: () => void): Promise<void> {
    if (this.running) throw new Error('正在上传另一项');
    if (!BrainAPI.active(job.generation)) throw new Error('此文件属于另一资料库连接，请恢复原连接后继续');
    BrainAPI.requireUnlocked();
    const lease = BrainAPI.lease();
    BrainAPI.assertLease(lease);
    this.running = true;
    try {
      if (job.fileId) {
        await this.refresh(job); changed(); return;
      }
      if (!job.uploadId) {
        const receipt = await BrainAPI.post('/upload/start', { 'name': job.name, 'size': job.size, 'identity': 'harmony:' + job.id }, lease);
        job.uploadId = text(receipt, 'id');
        if (!job.uploadId) throw new Error('资料库未返回上传编号');
        this.save();
      }
      const path = '/upload/' + encodeURIComponent(job.uploadId);
      const state = await BrainAPI.get(path);
      let offset = Number(state['received'] ?? 0);
      const chunk = Math.min(Number(state['chunk'] ?? 8 * 1024 * 1024), 8 * 1024 * 1024);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > job.size || !Number.isSafeInteger(chunk) || chunk <= 0) {
        throw new Error('资料库上传偏移或分片大小无效');
      }
      const source = fileIo.openSync(this.root + '/' + job.id, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW);
      try {
        while (offset < job.size) {
          BrainAPI.requireUnlocked();
          if (!BrainAPI.active(job.generation)) throw new Error('连接已改变');
          const buffer = new ArrayBuffer(Math.min(chunk, job.size - offset));
          fileIo.lseek(source.fd, offset, fileIo.WhenceType.SEEK_SET);
          const read = fileIo.readSync(source.fd, buffer);
          if (read !== buffer.byteLength) throw new Error('本地文件读取不完整');
          const hash = cryptoFramework.createMd('SHA256');
          await hash.update({ data: new Uint8Array(buffer) });
          const digest = (await hash.digest()).data;
          BrainAPI.assertLease(lease);
          let hex = '';
          for (let i = 0; i < digest.length; i++) hex += digest[i].toString(16).padStart(2, '0');
          const receipt = await BrainAPI.postBytes(path + '?offset=' + offset, buffer, 'application/octet-stream', { 'X-Chunk-SHA256': hex }, lease);
          const received = Number(receipt['received']);
          if (received !== offset + read) throw new Error('分片回执偏移不一致，请重新继续核对');
          offset = received;
          job.received = offset;
          job.stage = '上传中';
          this.save(); changed();
        }
      } finally { fileIo.closeSync(source); }
      job.stage = '已收到，正在校验'; this.save(); changed();
      const receipt = await BrainAPI.post(path + '/finish', {}, lease);
      job.fileId = text(receipt, 'file_id');
      job.stage = '校验完整，正在理解内容'; this.save(); changed();
      if (job.fileId) { await this.refresh(job); changed(); }
    } finally { this.running = false; }
  }
  private async refresh(job: BrainUploadJob): Promise<void> {
    const pipeline = await BrainAPI.get('/pipeline', '?ids=' + encodeURIComponent(job.fileId) + '&limit=1');
    const rows = items(pipeline);
    if (rows.length === 0) return;
    const stages = items(rows[0], 'stages');
    if (stages.length && stages.every((stage: BrainJSON) => text(stage, 'state') === 'completed' || text(stage, 'state') === 'done' || text(stage, 'state') === 'skipped')) {
      job.stage = '内容理解完成'; this.save();
    } else if (stages.some((stage: BrainJSON) => text(stage, 'state') === 'failed')) {
      job.stage = '原件已保存，部分理解步骤失败，请到资料中查看'; this.save();
    }
  }
  remove(id: string): void {
    if (this.running) throw new Error('请等待当前上传结束');
    const job = this.jobs.find((row: BrainUploadJob) => row.id === id);
    if (!job) return;
    this.jobs = this.jobs.filter((row: BrainUploadJob) => row.id !== id);
    this.save();
    if (fileIo.accessSync(this.root + '/' + job.id)) fileIo.unlinkSync(this.root + '/' + job.id);
  }
}
