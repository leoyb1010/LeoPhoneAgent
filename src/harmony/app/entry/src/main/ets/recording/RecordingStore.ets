import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { atomicWriteText } from '../store/AtomicFile';

export class RecordingRecord {
  id: string = '';
  title: string = '';
  createdAt: number = 0;
  bytes: number = 0;
  state: string = 'recording';
  transcript: string = '';
  minutes: string = '';
  error: string = '';
}

export class RecordingStore {
  static directory(context: common.Context): string {
    const path = context.filesDir + '/recordings';
    if (!fileIo.accessSync(path)) {
      fileIo.mkdirSync(path);
    }
    return path;
  }

  static path(context: common.Context, id: string, extension: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id) || !['json', 'wav'].includes(extension)) {
      throw new Error('录音标识无效');
    }
    return RecordingStore.directory(context) + '/' + id + '.' + extension;
  }

  static create(context: common.Context): RecordingRecord {
    const row = new RecordingRecord();
    row.id = util.generateRandomUUID(true);
    row.createdAt = Date.now();
    row.title = '录音 ' + new Date(row.createdAt).toLocaleString();
    RecordingStore.save(context, row);
    return row;
  }

  static save(context: common.Context, row: RecordingRecord): void {
    atomicWriteText(RecordingStore.path(context, row.id, 'json'), JSON.stringify(row));
  }

  static list(context: common.Context): RecordingRecord[] {
    const result: RecordingRecord[] = [];
    const names = fileIo.listFileSync(RecordingStore.directory(context));
    for (const name of names) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) {
        continue;
      }
      const row = JSON.parse(fileIo.readTextSync(RecordingStore.directory(context) + '/' + name)) as RecordingRecord;
      if (!row.id || name !== row.id + '.json') {
        continue;
      }
      result.push(row);
    }
    return result.sort((a: RecordingRecord, b: RecordingRecord) => b.createdAt - a.createdAt);
  }

  static remove(context: common.Context, row: RecordingRecord): void {
    const wav = RecordingStore.path(context, row.id, 'wav');
    if (fileIo.accessSync(wav)) {
      fileIo.unlinkSync(wav);
    }
    fileIo.unlinkSync(RecordingStore.path(context, row.id, 'json'));
  }
}

/** RIFF PCM header, 16 kHz / mono / signed 16-bit. */
export function wavHeader(bytes: number): ArrayBuffer {
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > 0x7fffffff || bytes % 2 !== 0) {
    throw new Error('录音长度无效');
  }
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const signature = 'RIFF';
  for (let i = 0; i < 4; i++) { view.setUint8(i, signature.charCodeAt(i)); }
  view.setUint32(4, bytes + 36, true);
  const format = 'WAVEfmt ';
  for (let i = 0; i < format.length; i++) { view.setUint8(8 + i, format.charCodeAt(i)); }
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  const data = 'data';
  for (let i = 0; i < 4; i++) { view.setUint8(36 + i, data.charCodeAt(i)); }
  view.setUint32(40, bytes, true);
  return buffer;
}
