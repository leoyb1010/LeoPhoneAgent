import { ActionButton } from '../theme/Controls';
import { common } from '@kit.AbilityKit';
import { media } from '@kit.MediaKit';
import { fileIo } from '@kit.CoreFileKit';
import { RecordingRecord, RecordingStore } from '../recording/RecordingStore';
import { RecordingController } from '../recording/RecordingController';
import { RecordingTranscriber } from '../recording/RecordingTranscriber';
import { NavBar } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

@Entry
@Component
struct RecordingsPage {
  @State records: RecordingRecord[] = [];
  @State selected: RecordingRecord | null = null;
  @State recording: boolean = false;
  @State busy: boolean = false;
  @State processingId: string = '';
  @State processingSummary: boolean = false;
  @State error: string = '';
  private player: media.AVPlayer | null = null;
  private playbackFile: fileIo.File | null = null;

  aboutToAppear(): void { this.refresh(); }
  aboutToDisappear(): void { this.stopPlayback(); }

  private refresh(): void {
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      this.records = RecordingStore.list(ctx);
      this.records.forEach((row: RecordingRecord) => {
        if (row.state === 'recording' && RecordingController.current?.id !== row.id) {
          RecordingController.recover(ctx, row);
        }
      });
      this.recording = RecordingController.current !== null;
    } catch (_err) { this.error = '读取录音失败，请检查存储空间'; }
  }

  build() {
    Column() {
      NavBar({ title: '录音与纪要' })
      Row({ space: 12 }) {
        ActionButton({ label: this.recording ? '结束录音' : '开始录音', variant: 'secondary', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => { this.toggleRecording(); } })
        Text(this.recording ? '正在录音，音频每秒保存' : '录音在本机保存').fontSize(13).fontColor(Tokens.muted)
      }.padding(20).width('100%').constraintSize({ maxWidth: 720 })
      if (this.error) { Text(this.error).fontSize(14).fontColor(Tokens.warn).padding(12) }
      Scroll() {
        Column({ space: 16 }) {
          ForEach(this.records, (row: RecordingRecord) => {
            Column({ space: 10 }) {
              Text(row.title).fontSize(17).fontWeight(FontWeight.Medium).fontColor(Tokens.text)
              Text(`${Math.round(row.bytes / 32000)} 秒 · ${this.stateLabel(row.state)}`)
                .fontSize(13).fontColor(Tokens.muted)
              if (row.error) { Text(row.error).fontSize(13).fontColor(Tokens.warn) }
              Row({ space: 8 }) {
                ActionButton({ label: '播放', variant: 'secondary', fullWidth: false, busy: false, isEnabled: !this.recording && !this.busy && row.bytes > 0, onTap: () => { this.play(row); } })
                ActionButton({ label: '转写', variant: 'secondary', fullWidth: false, busy: this.busy && this.processingId === row.id && !this.processingSummary, isEnabled: !this.recording && !this.busy && row.bytes > 0, onTap: () => { this.process(row, false); } })
                ActionButton({ label: '生成纪要', variant: 'primary', fullWidth: false, busy: this.busy && this.processingId === row.id && this.processingSummary, isEnabled: !this.recording && !this.busy && row.transcript.length > 0, onTap: () => {
                    AlertDialog.show({ title: '发送转写给当前模型', message: '录音文字将发送给你配置的 AI 服务商生成纪要。',
                      confirm: { value: '生成纪要', action: () => { this.process(row, true); } },
                      cancel: () => {} });
                  } })
              }
              if (row.transcript) {
                Text(row.transcript).fontSize(15).fontColor(Tokens.text).copyOption(CopyOptions.InApp)
              }
              if (row.minutes) {
                Text(row.minutes).fontSize(15).fontColor(Tokens.text).copyOption(CopyOptions.InApp)
              }
              ActionButton({ label: '删除录音', variant: 'danger', fullWidth: false, busy: false, isEnabled: !this.busy && !this.recording, onTap: () => {
                AlertDialog.show({ title: '删除录音和文字', message: '将删除这段音频、转写和纪要。',
                  confirm: { value: '删除', action: () => { this.remove(row); } },
                  cancel: () => {} });
              } })
            }.width('100%').alignItems(HorizontalAlign.Start).padding(16).backgroundColor(Tokens.card).borderRadius(16)
          }, (row: RecordingRecord) => row.id + row.state + row.transcript.length + row.minutes.length)
        }.padding(20).width('100%').constraintSize({ maxWidth: 720 })
      }.layoutWeight(1)
    }.height('100%').width('100%').backgroundColor(Tokens.grouped)
  }

  private stateLabel(state: string): string {
    if (state === 'recording') { return '录音中'; }
    if (state === 'transcribing') { return '转写中'; }
    if (state === 'summarizing') { return '生成纪要中'; }
    if (state === 'completed') { return '纪要已生成'; }
    if (state === 'interrupted') { return '录音已恢复'; }
    if (state === 'transcribed') { return '已转写'; }
    if (state.endsWith('_failed')) { return '处理失败，可重试'; }
    return '已保存';
  }

  private async toggleRecording(): Promise<void> {
    this.busy = true;
    this.error = '';
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      this.stopPlayback();
      if (this.recording) { await RecordingController.stop(ctx); }
      else { await RecordingController.start(ctx); }
    } catch (err) { this.error = `${err}`; }
    finally { this.busy = false; this.refresh(); }
  }

  private async process(row: RecordingRecord, summary: boolean): Promise<void> {
    this.processingId = row.id; this.processingSummary = summary;
    this.busy = true;
    this.error = '';
    try {
      this.stopPlayback();
      if (summary) { await RecordingTranscriber.summarize(getContext(this), row); }
      else { await RecordingTranscriber.transcribe(getContext(this), row); }
    } catch (err) { this.error = `${err}`; }
    finally { this.busy = false; this.processingId = ''; this.refresh(); }
  }

  private remove(row: RecordingRecord): void {
    try { this.stopPlayback(); RecordingStore.remove(getContext(this), row); this.refresh(); }
    catch (_err) { this.error = '删除失败，请重试'; }
  }

  private async play(row: RecordingRecord): Promise<void> {
    this.stopPlayback();
    try {
      const player = await media.createAVPlayer();
      this.player = player;
      this.playbackFile = fileIo.openSync(RecordingStore.path(getContext(this), row.id, 'wav'), fileIo.OpenMode.READ_ONLY);
      player.on('stateChange', (state: string) => {
        if (player !== this.player) { return; }
        if (state === 'initialized') { player.prepare().catch(() => { this.error = '音频准备失败'; }); }
        if (state === 'prepared') { player.play().catch(() => { this.error = '音频播放失败'; }); }
        if (state === 'completed') { this.stopPlayback(); }
      });
      player.on('error', () => { this.error = '播放失败，原录音已保留'; this.stopPlayback(); });
      player.fdSrc = { fd: this.playbackFile.fd, offset: 0, length: row.bytes + 44 };
    } catch (_err) { this.error = '无法播放录音'; this.stopPlayback(); }
  }

  private stopPlayback(): void {
    const player = this.player;
    const file = this.playbackFile;
    this.player = null;
    this.playbackFile = null;
    if (player) {
      player.release().catch(() => {}).finally(() => { if (file) { fileIo.closeSync(file); } });
    } else if (file) { fileIo.closeSync(file); }
  }
}
