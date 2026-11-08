import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { atomicWriteText } from '../store/AtomicFile';
import { PendingImage } from './ChatRun';

export class ChatViewSnapshot {
  draft: string = '';
  files: string[] = [];
  image: PendingImage | null = null;
  images: PendingImage[] = [];
  thinking: string = '';
  providerId: string = '';
  modelId: string = '';
  modelPicked: boolean = false;
  memoryEnabled: boolean = true;
  openTurns: number[] = [];
  nearBottom: boolean = true;
  offset: number = 0;
  listening: boolean = false;
  voiceVersion: number = 0;
  voiceGeneration: number = 0;
  stopListen: (() => void) | null = null;
  voiceError: string = '';
  submissionId: string = '';
  submittedText: string = '';
  submittedFiles: string[] = [];
  submittedImage: string = '';
}
class DiskImage { name: string = ''; mime: string = ''; }
class DiskDraft {
  submissionId: string = '';
  id: string = '';
  text: string = '';
  files: string[] = [];
  images: DiskImage[] = [];
  imageName: string = '';
  imageMime: string = '';
  thinking: string = '';
  providerId: string = '';
  modelId: string = '';
  modelPicked: boolean = false;
  memoryEnabled: boolean = true;
  offset: number = 0;
  nearBottom: boolean = true;
  openTurns: number[] = [];
}
class DraftFile { format: string = 'leobot-local-drafts'; version: number = 1; rows: DiskDraft[] = []; }

/** Conversation-owned view state. Unsent drafts stay local and never create a Session. */
export class ChatViewState {
  private static rows: Map<string, ChatViewSnapshot> = new Map();
  private static context: common.Context | null = null;
  private static initialized: boolean = false;
  private static readable: boolean = true;
  private static timer: number = -1;
  private static committed: string = '';
  static lastError: string = '';

  static initialize(context: common.Context): void {
    if (ChatViewState.initialized) return;
    ChatViewState.context = context; ChatViewState.initialized = true;
    const path = context.filesDir + '/chat-drafts.json';
    if (!fileIo.accessSync(path)) return;
    try {
      if (fileIo.lstatSync(path).isSymbolicLink() || fileIo.statSync(path).size > 64 * 1024 * 1024) throw new Error('草稿文件不安全或超过大小限制');
      const raw = fileIo.readTextSync(path); const data = JSON.parse(raw) as DraftFile;
      if (data.format !== 'leobot-local-drafts' || data.version !== 1 || !Array.isArray(data.rows) || data.rows.length > 10000) throw new Error('草稿格式无法读取');
      for (let i = 0; i < data.rows.length; i++) {
        const draft = data.rows[i];
        if (!draft || typeof draft.id !== 'string' || !ChatViewState.validId(draft.id) || typeof draft.text !== 'string' || !Array.isArray(draft.files)) throw new Error('草稿记录格式无法读取');
        if (draft.submissionId && ChatViewState.wasAdmitted(context, draft.id, draft.submissionId)) continue;
        const row = ChatViewState.get(draft.id); row.draft = draft.text;
        row.submissionId = typeof draft.submissionId === 'string' ? draft.submissionId : '';
        row.submittedText = draft.text;
        row.files = draft.files.filter((name: string) => typeof name === 'string' && ChatViewState.safeFile(context, 'workspace', name));
        if (Array.isArray(draft.images) && draft.images.length > 16) throw new Error('草稿图片数量超出限制');
        row.images = Array.isArray(draft.images) ? draft.images.map((image: DiskImage) => ChatViewState.restoreImage(context, image.name, image.mime)).filter((image: PendingImage | null) => image !== null) as PendingImage[] : [];
        row.image = row.images[0] ?? (draft.imageName ? ChatViewState.restoreImage(context, draft.imageName, draft.imageMime) : null);
        if (!row.images.length && row.image) row.images = [row.image];
        row.submittedFiles = row.files.slice(); row.submittedImage = ChatViewState.imageKey(row);
        row.thinking = typeof draft.thinking === 'string' ? draft.thinking : '';
        row.providerId = typeof draft.providerId === 'string' ? draft.providerId : ''; row.modelId = typeof draft.modelId === 'string' ? draft.modelId : '';
        row.modelPicked = draft.modelPicked === true; row.memoryEnabled = draft.memoryEnabled !== false;
        row.offset = Number.isFinite(draft.offset) && draft.offset >= 0 ? draft.offset : 0; row.nearBottom = draft.nearBottom !== false;
        row.openTurns = Array.isArray(draft.openTurns) ? draft.openTurns.filter((value: number) => Number.isSafeInteger(value) && value >= 0) : [];
        if (row.files.length !== draft.files.length || (draft.imageName && !row.image)) ChatViewState.report('草稿附件读取失败，文字和其他可用内容已保留');
      }
      ChatViewState.committed = raw;
    } catch (error) { ChatViewState.readable = false; ChatViewState.report(`草稿读取失败，原文件已保留，${error}`); }
  }

  static get(id: string): ChatViewSnapshot {
    let row = ChatViewState.rows.get(id);
    if (!row) { row = new ChatViewSnapshot(); ChatViewState.rows.set(id, row); }
    return row;
  }
  static draftText(id: string): string { return ChatViewState.rows.get(id)?.draft ?? ''; }
  static moveDraft(from: string, to: string): void {
    const row = ChatViewState.get(from); ChatViewState.rows.set(to, row); ChatViewState.rows.delete(from); ChatViewState.persistSoon();
  }
  static changed(): void {
    AppStorage.setOrCreate('chatViewTick', (AppStorage.get<number>('chatViewTick') ?? 0) + 1); ChatViewState.persistSoon();
  }
  static persistSoon(): void {
    if (!ChatViewState.context || !ChatViewState.readable) return;
    AppStorage.setOrCreate('draftTick', (AppStorage.get<number>('draftTick') ?? 0) + 1);
    if (ChatViewState.timer >= 0) clearTimeout(ChatViewState.timer);
    ChatViewState.timer = setTimeout(() => { ChatViewState.timer = -1; try { ChatViewState.flushOrThrow(); } catch (_error) {} }, 220);
  }
  static flush(): void { try { ChatViewState.flushOrThrow(); } catch (_error) {} }
  static flushOrThrow(): void {
    if (ChatViewState.timer >= 0) { clearTimeout(ChatViewState.timer); ChatViewState.timer = -1; }
    const context = ChatViewState.context; if (!context) throw new Error('草稿存储尚未初始化');
    if (!ChatViewState.readable) throw new Error(ChatViewState.lastError || '原草稿文件无法读取，暂不覆盖');
    const file = new DraftFile();
    ChatViewState.rows.forEach((row: ChatViewSnapshot, id: string) => {
      if (!ChatViewState.validId(id)) return;
      if (!row.draft && !row.files.length && !row.image && !row.images.length && !row.modelPicked && row.memoryEnabled && !row.thinking && row.offset === 0) return;
      const draft = new DiskDraft(); draft.id = id; draft.text = row.draft;
      if (ChatViewState.sameSubmission(row)) draft.submissionId = row.submissionId;
      draft.files = row.files.filter((name: string) => ChatViewState.safeFile(context, 'workspace', name));
      const media = row.images.length ? row.images : (row.image ? [row.image] : []);
      for (const image of media) {
        const prefix = context.filesDir + '/chat-images/'; const name = image.path.startsWith(prefix) ? image.path.substring(prefix.length) : '';
        if (ChatViewState.safeFile(context, 'chat-images', name)) { const part = new DiskImage(); part.name = name; part.mime = image.mime; draft.images.push(part); }
      }
      if (draft.images.length) { draft.imageName = draft.images[0].name; draft.imageMime = draft.images[0].mime; }
      draft.thinking = row.thinking; draft.providerId = row.providerId; draft.modelId = row.modelId; draft.modelPicked = row.modelPicked;
      draft.memoryEnabled = row.memoryEnabled; draft.offset = row.offset; draft.nearBottom = row.nearBottom; draft.openTurns = row.openTurns.slice(); file.rows.push(draft);
    });
    const raw = JSON.stringify(file); if (raw === ChatViewState.committed) return;
    try {
      if (new util.TextEncoder().encodeInto(raw).byteLength > 64 * 1024 * 1024) throw new Error('草稿保存超过 64 MB 限制，请先导出长文本');
      atomicWriteText(context.filesDir + '/chat-drafts.json', raw); ChatViewState.committed = raw; ChatViewState.lastError = '';
      AppStorage.setOrCreate('draftError', '');
    } catch (error) { ChatViewState.report(`草稿保存失败，当前输入仍在本机，${error}`); throw error as Error; }
  }

  static beginSubmission(id: string): string {
    const row = ChatViewState.get(id); row.submissionId = util.generateRandomUUID();
    row.submittedText = row.draft; row.submittedFiles = row.files.slice(); row.submittedImage = ChatViewState.imageKey(row);
    ChatViewState.flushOrThrow(); return row.submissionId;
  }
  static cancelSubmission(id: string): void { const row = ChatViewState.get(id); row.submissionId = ''; }
  static admitted(id: string, submissionId: string): void {
    if (!submissionId) return;
    const row = ChatViewState.rows.get(id); if (!row || row.submissionId !== submissionId) return;
    if (ChatViewState.sameSubmission(row)) { row.draft = ''; row.files = []; row.image = null; row.images = []; }
    row.submissionId = ''; ChatViewState.persistSoon();
  }
  private static imageKey(row: ChatViewSnapshot): string { return (row.images.length ? row.images : (row.image ? [row.image] : [])).map((image: PendingImage) => image.path).join('\n'); }
  private static sameSubmission(row: ChatViewSnapshot): boolean {
    return row.submissionId.length > 0 && row.draft === row.submittedText && ChatViewState.imageKey(row) === row.submittedImage &&
      row.files.length === row.submittedFiles.length && row.files.every((name: string, index: number) => name === row.submittedFiles[index]);
  }
  private static wasAdmitted(context: common.Context, id: string, submissionId: string): boolean {
    if (!ChatViewState.validId(id) || id === '' || id === 'home') return false;
    const root = context.filesDir + '/sessions'; const path = root + '/' + id + '.json';
    try {
      if (!fileIo.accessSync(path) || fileIo.lstatSync(root).isSymbolicLink() || fileIo.lstatSync(path).isSymbolicLink()) return false;
      const session = JSON.parse(fileIo.readTextSync(path)) as Record<string, Object>; const messages = session['messages'];
      return Array.isArray(messages) && messages.some((value: Object) => (value as Record<string, Object>)['submissionId'] === submissionId);
    } catch (_error) { return false; }
  }

  private static validId(id: string): boolean { return id === '' || id === 'home' || /^(?:s_\d+_\d+|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(id); }
  private static safeFile(context: common.Context, directory: string, name: string): boolean {
    if (!name || name === '.' || name === '..' || /[\/\\\0]/.test(name)) return false;
    try {
      const root = context.filesDir + '/' + directory; const path = root + '/' + name;
      if (!fileIo.accessSync(root) || !fileIo.accessSync(path)) return false;
      const parent = fileIo.lstatSync(root); const file = fileIo.lstatSync(path);
      return parent.isDirectory() && !parent.isSymbolicLink() && file.isFile() && !file.isSymbolicLink();
    } catch (_error) { return false; }
  }
  private static restoreImage(context: common.Context, name: string, mime: string): PendingImage | null {
    if (!ChatViewState.safeFile(context, 'chat-images', name)) return null;
    const path = context.filesDir + '/chat-images/' + name; const stat = fileIo.statSync(path); if (stat.size > 8 * 1024 * 1024) return null;
    const file = fileIo.openSync(path, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW); const buffer = new ArrayBuffer(stat.size);
    try { if (fileIo.readSync(file.fd, buffer) !== buffer.byteLength) return null; } finally { fileIo.closeSync(file); }
    const image = new PendingImage(); image.path = path; image.mime = mime === 'image/png' ? mime : 'image/jpeg'; image.b64 = new util.Base64Helper().encodeToStringSync(new Uint8Array(buffer)); return image;
  }
  private static report(message: string): void { ChatViewState.lastError = message; AppStorage.setOrCreate('draftError', message); }
}
