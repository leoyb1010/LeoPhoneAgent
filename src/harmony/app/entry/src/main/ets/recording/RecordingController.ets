import { abilityAccessCtrl, common, wantAgent } from '@kit.AbilityKit';
import { audio } from '@kit.AudioKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { fileIo } from '@kit.CoreFileKit';
import { RecordingRecord, RecordingStore, wavHeader } from './RecordingStore';

class RecordingOperation {
  row: RecordingRecord = new RecordingRecord();
  capturer: audio.AudioCapturer | null = null;
  file: fileIo.File | null = null;
  reading: Promise<void> | null = null;
  backgroundId: number = -1;
  cancelled: boolean = false;
}

export class RecordingController {
  private static active: RecordingOperation | null = null;
  private static stopping: Promise<void> | null = null;
  static current: RecordingRecord | null = null;
  static backgroundAvailable: boolean = false;

  private static live(operation: RecordingOperation): boolean {
    return RecordingController.active === operation && !operation.cancelled;
  }

  static async start(context: common.UIAbilityContext): Promise<RecordingRecord> {
    if (RecordingController.active || RecordingController.stopping) { throw new Error('已有一段录音正在进行'); }
    // Reserve ownership before permission/capturer awaits so early stop also cancels startup.
    const operation = new RecordingOperation();
    operation.row = RecordingStore.create(context);
    RecordingController.active = operation;
    RecordingController.current = operation.row;
    try {
      const grant = await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(context, ['ohos.permission.MICROPHONE']);
      if (!RecordingController.live(operation)) { throw new Error('录音启动已取消'); }
      if (grant.authResults[0] !== 0) { throw new Error('请授权麦克风'); }
      operation.file = fileIo.openSync(RecordingStore.path(context, operation.row.id, 'wav'),
        fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC);
      RecordingController.write(operation, wavHeader(0));
      const capturer = await audio.createAudioCapturer({
        streamInfo: { samplingRate: audio.AudioSamplingRate.SAMPLE_RATE_16000, channels: audio.AudioChannel.CHANNEL_1,
          sampleFormat: audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE, encodingType: audio.AudioEncodingType.ENCODING_TYPE_RAW },
        capturerInfo: { source: audio.SourceType.SOURCE_TYPE_MIC, capturerFlags: 0 }
      });
      if (!RecordingController.live(operation)) {
        await capturer.release().catch(() => {});
        throw new Error('录音启动已取消');
      }
      operation.capturer = capturer;
      await capturer.start();
      if (!RecordingController.live(operation)) {
        await capturer.stop().catch(() => {});
        await capturer.release().catch(() => {});
        throw new Error('录音启动已取消');
      }
      await RecordingController.holdBackground(context, operation);
      if (!RecordingController.live(operation)) { throw new Error('录音启动已取消'); }
      operation.reading = RecordingController.pump(context, operation);
      return operation.row;
    } catch (err) {
      if (RecordingController.active === operation) {
        operation.row.error = `${err}`;
        await RecordingController.stop(context);
      }
      throw new Error(`${err}`);
    }
  }

  private static write(operation: RecordingOperation, buffer: ArrayBuffer): void {
    if (!RecordingController.live(operation) || !operation.file ||
      fileIo.writeSync(operation.file.fd, buffer) !== buffer.byteLength) { throw new Error('录音写入不完整'); }
  }

  private static async pump(context: common.Context, operation: RecordingOperation): Promise<void> {
    const capturer = operation.capturer;
    if (!capturer) { return; }
    const row = operation.row;
    let saved = 0;
    try {
      while (RecordingController.live(operation) && row.state === 'recording') {
        const bytes = await capturer.read(3200, true);
        if (!RecordingController.live(operation)) { break; }
        if (bytes.byteLength === 0) { throw new Error('录音数据已中断'); }
        RecordingController.write(operation, bytes);
        row.bytes += bytes.byteLength;
        if (row.bytes - saved >= 32000) {
          fileIo.fsyncSync(operation.file!.fd);
          RecordingStore.save(context, row);
          saved = row.bytes;
        }
        if (row.bytes >= 32000 * 60 * 120) {
          setTimeout(() => { if (RecordingController.active === operation) { RecordingController.stop(context).catch(() => {}); } }, 0);
          break;
        }
      }
    } catch (_err) {
      if (RecordingController.live(operation)) {
        row.error = '录音中断，已写入的音频可恢复';
        setTimeout(() => { if (RecordingController.active === operation) { RecordingController.stop(context).catch(() => {}); } }, 0);
      }
    }
  }

  static stop(context: common.Context): Promise<void> {
    const operation = RecordingController.active;
    if (!operation) { return RecordingController.stopping ?? Promise.resolve(); }
    operation.cancelled = true;
    if (!RecordingController.stopping) {
      RecordingController.stopping = RecordingController.finish(context, operation).finally(() => {
        RecordingController.stopping = null;
      });
    }
    return RecordingController.stopping;
  }

  private static async finish(context: common.Context, operation: RecordingOperation): Promise<void> {
    const row = operation.row;
    row.state = row.error ? 'interrupted' : 'stopped';
    try {
      await operation.capturer?.stop().catch(() => {});
      await operation.reading;
      await operation.capturer?.release().catch(() => {});
      if (operation.file) {
        fileIo.fsyncSync(operation.file.fd);
        fileIo.closeSync(operation.file);
        operation.file = null;
      }
      const path = RecordingStore.path(context, row.id, 'wav');
      if (fileIo.accessSync(path)) {
        const header = fileIo.openSync(path, fileIo.OpenMode.READ_WRITE);
        try {
          if (fileIo.writeSync(header.fd, wavHeader(row.bytes)) !== 44) { throw new Error('录音头写入不完整'); }
          fileIo.fsyncSync(header.fd);
        } finally { fileIo.closeSync(header); }
      }
    } catch (_err) {
      row.state = 'interrupted';
      row.error = '录音保存中断，重新打开页面可恢复已写入的音频';
    } finally {
      if (operation.file) { try { fileIo.closeSync(operation.file); } catch (_err) {} }
      if (operation.backgroundId >= 0) {
        await backgroundTaskManager.stopBackgroundRunning(context, operation.backgroundId).catch(() => {});
      }
      if (RecordingController.active === operation) {
        RecordingController.active = null;
        RecordingController.current = null;
        RecordingController.backgroundAvailable = false;
      }
      RecordingStore.save(context, row);
    }
  }

  private static async holdBackground(context: common.UIAbilityContext, operation: RecordingOperation): Promise<void> {
    try {
      const agent = await wantAgent.getWantAgent({
        wants: [{ bundleName: 'com.leoyuan.leophoneagent.harmony', abilityName: 'EntryAbility' }],
        operationType: wantAgent.OperationType.START_ABILITY, requestCode: 73001,
        wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
      });
      if (!RecordingController.live(operation)) { return; }
      const request = new backgroundTaskManager.ContinuousTaskRequest();
      request.backgroundTaskModes = [backgroundTaskManager.BackgroundTaskMode.MODE_AUDIO_RECORDING];
      request.wantAgent = agent;
      const result = await backgroundTaskManager.startBackgroundRunning(context, request);
      const id = result.continuousTaskId ?? -1;
      if (!RecordingController.live(operation)) {
        if (id >= 0) { await backgroundTaskManager.stopBackgroundRunning(context, id).catch(() => {}); }
        return;
      }
      operation.backgroundId = id;
      RecordingController.backgroundAvailable = id >= 0;
    } catch (_err) { if (RecordingController.live(operation)) { RecordingController.backgroundAvailable = false; } }
  }

  static recover(context: common.Context, row: RecordingRecord): void {
    if (RecordingController.current?.id === row.id) { return; }
    const path = RecordingStore.path(context, row.id, 'wav');
    if (!fileIo.accessSync(path)) { return; }
    const file = fileIo.openSync(path, fileIo.OpenMode.READ_WRITE);
    try {
      const bytes = Math.max(0, fileIo.statSync(file.fd).size - 44);
      row.bytes = bytes - bytes % 2;
      if (fileIo.writeSync(file.fd, wavHeader(row.bytes)) !== 44) { throw new Error('录音头修复失败'); }
      fileIo.fsyncSync(file.fd);
      if (row.state === 'recording' || row.state === 'stopping') {
        row.state = 'interrupted'; row.error = '上次录音被中断，音频已恢复';
      }
      RecordingStore.save(context, row);
    } finally { fileIo.closeSync(file); }
  }
}
