import { image } from '@kit.ImageKit';
import { atomicWriteText } from './AtomicFile';
import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import {
  ChatImage,
  chatImages,
  FailoverSlot,
  LocalChatMessage,
  LocalSessionArchive,
  bucketTitle,
  dateBucket,
  sessionArchiveFromJson,
  sessionArchiveJson,
  titleFromPrompt
} from '../local/LocalProtocol';

export class LocalSessionSummary {
  id: string = '';
  title: string = '新任务';
  lastMessage: string = '';
  updatedAt: number = 0;
  archived: boolean = false;
  pinned: boolean = false;
}

export class LocalSession {
  id: string = '';
  title: string = '新任务';
  lastMessage: string = '';
  updatedAt: number = 0;
  archived: boolean = false;
  pinned: boolean = false;
  /** 有一轮正在跑。App 被杀后读回来还是 true,就知道那一轮没做完(显示「继续」)。 */
  running: boolean = false;
  modelQueue: FailoverSlot[] = [];
  unresolvedModelId: string = '';
  memoryEnabled: boolean = true;
  modelGroupId: string = '';
  messages: LocalChatMessage[] = [];
}

export class SessionGroup {
  key: string = '';
  title: string = '';
  rows: LocalSessionSummary[] = [];
}

export class SessionStore {
  summaries: LocalSessionSummary[] = [];
  jsonLoadFailed: boolean = false;
  lastError: string = '';
  private loaded: boolean = false;
  private pending: Promise<void> | null = null;
  private cache: Map<string, LocalSession> = new Map();

  ensureLoaded(context: common.Context): Promise<void> {
    if (this.loaded) {
      return Promise.resolve();
    }
    if (!this.pending) {
      this.pending = this.load(context).catch((err: Error) => {
        this.pending = null;
        throw err;
      });
    }
    return this.pending;
  }

  listActive(): LocalSessionSummary[] {
    return this.summaries.filter((row: LocalSessionSummary) => !row.archived);
  }

  search(query: string): LocalSessionSummary[] {
    const needle = query.trim().toLowerCase();
    const rows = this.listActive();
    if (!needle) {
      return rows;
    }
    return rows.filter((row: LocalSessionSummary) => {
      return row.title.toLowerCase().indexOf(needle) >= 0 ||
        row.lastMessage.toLowerCase().indexOf(needle) >= 0;
    });
  }

  grouped(query: string): SessionGroup[] {
    const rows = this.search(query);
    const order: string[] = ['pinned', 'today', 'yesterday', 'week', 'month', 'earlier'];
    const map: Map<string, LocalSessionSummary[]> = new Map();
    for (let i = 0; i < order.length; i++) {
      map.set(order[i], []);
    }
    for (let i = 0; i < rows.length; i++) {
      const key = rows[i].pinned ? 'pinned' : dateBucket(rows[i].updatedAt);
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(rows[i]);
      }
    }
    const out: SessionGroup[] = [];
    for (let i = 0; i < order.length; i++) {
      const key = order[i];
      const bucket = map.get(key) ?? [];
      if (bucket.length === 0) {
        continue;
      }
      const group = new SessionGroup();
      group.key = key;
      group.title = bucketTitle(key);
      group.rows = bucket;
      out.push(group);
    }
    return out;
  }

  async load(context: common.Context): Promise<void> {
    this.jsonLoadFailed = false;
    this.lastError = '';
    SessionStore.ensureDir(SessionStore.dir(context));
    const indexPath = SessionStore.indexPath(context);
    let listed: LocalSessionSummary[] = [];
    if (fileIo.accessSync(indexPath)) {
      try {
        const parsed = JSON.parse(fileIo.readTextSync(indexPath)) as Object[];
        if (!Array.isArray(parsed)) {
          throw new Error('index not array');
        }
        listed = parsed.map((row: Object) => SessionStore.summaryFrom(row as Record<string, Object>, ''));
      } catch (err) {
        // 目录坏了不等于对话坏了:下面按每条对话自己的档案重建。
        this.lastError = `${err}`;
      }
    }
    try {
      this.summaries = this.reconcile(context, listed);
    } catch (err) {
      this.jsonLoadFailed = true;
      this.lastError = `${err}`;
      this.summaries = [];
    }
    this.loaded = true;
  }

  /**
   * 目录以磁盘上真有的对话档案为准:目录里有、档案没了的去掉;档案在、目录里没有的补上
   * (后台定时任务和前台各自写目录会互相盖掉对方新建的对话,补回来就不会「消失」)。
   */
  private reconcile(context: common.Context, listed: LocalSessionSummary[]): LocalSessionSummary[] {
    const names = fileIo.listFileSync(SessionStore.dir(context));
    const onDisk: Set<string> = new Set();
    for (let i = 0; i < names.length; i++) {
      const id = names[i].endsWith('.json') ? names[i].slice(0, -5) : '';
      if (SessionStore.validId(id)) {
        onDisk.add(id);
      }
    }
    const out: LocalSessionSummary[] = [];
    const seen: Set<string> = new Set();
    for (let i = 0; i < listed.length; i++) {
      const row = listed[i];
      if (onDisk.has(row.id) && !seen.has(row.id)) {
        out.push(row);
        seen.add(row.id);
      }
    }
    let changed = out.length !== listed.length;
    onDisk.forEach((id: string) => {
      if (seen.has(id)) {
        return;
      }
      try {
        const obj = JSON.parse(fileIo.readTextSync(SessionStore.sessionPath(context, id))) as Record<string, Object>;
        out.push(SessionStore.summaryFrom(obj, id));
        changed = true;
      } catch (_err) {
        // 这一条档案本身坏了就跳过,不连累其他对话
      }
    });
    out.sort((a: LocalSessionSummary, b: LocalSessionSummary) => b.updatedAt - a.updatedAt);
    if (changed) {
      SessionStore.writeText(SessionStore.indexPath(context), JSON.stringify(out));
    }
    return out;
  }

  private static summaryFrom(item: Record<string, Object>, fallbackId: string): LocalSessionSummary {
    const summary = new LocalSessionSummary();
    summary.id = `${item['id'] ?? fallbackId}`;
    summary.title = `${item['title'] ?? '新任务'}`;
    summary.lastMessage = `${item['lastMessage'] ?? ''}`;
    summary.updatedAt = Number(item['updatedAt'] ?? 0);
    summary.archived = item['archived'] === true;
    summary.pinned = item['pinned'] === true;
    return summary;
  }

  /** 对话编号只能是 create() 发的样子,外部链接带进来的编号不能拼成别的路径。 */
  static validId(id: string): boolean {
    return /^(?:s_\d+_\d+|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(id);
  }

  async create(context: common.Context, title: string = ''): Promise<LocalSession> {
    await this.ensureLoaded(context);
    this.assertWritable();
    const session = new LocalSession();
    session.id = `s_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    session.title = title.trim() || '新任务';
    session.updatedAt = Date.now();
    session.messages = [];
    this.cache.set(session.id, session);
    this.upsertSummary(session);
    this.persist(context, session);
    return session;
  }

  async get(context: common.Context, id: string): Promise<LocalSession | null> {
    await this.ensureLoaded(context);
    if (!SessionStore.validId(id)) {
      return null;
    }
    const hit = this.cache.get(id);
    if (hit) {
      this.fillImageBytes(context, hit.messages);
      return hit;
    }
    const path = SessionStore.sessionPath(context, id);
    if (!fileIo.accessSync(path)) {
      return null;
    }
    try {
      const raw = fileIo.readTextSync(path);
      const obj = JSON.parse(raw) as Record<string, Object>;
      const session = new LocalSession();
      session.id = `${obj['id'] ?? id}`;
      session.title = `${obj['title'] ?? '新任务'}`;
      session.lastMessage = `${obj['lastMessage'] ?? ''}`;
      session.updatedAt = Number(obj['updatedAt'] ?? 0);
      session.archived = obj['archived'] === true;
      session.pinned = obj['pinned'] === true;
      session.running = obj['running'] === true;
      session.memoryEnabled = obj['memoryEnabled'] !== false;
      session.modelGroupId = typeof obj['modelGroupId'] === 'string' ? obj['modelGroupId'] as string : '';
      session.unresolvedModelId = typeof obj['unresolvedModelId'] === 'string' ? obj['unresolvedModelId'] as string : '';
      const queue = obj['modelQueue'];
      if (Array.isArray(queue)) {
        for (let i = 0; i < queue.length; i++) {
          const entry = queue[i] as Record<string, Object>;
          if (typeof entry['instanceId'] === 'string' && typeof entry['model'] === 'string') {
            const slot = new FailoverSlot();
            slot.instanceId = entry['instanceId'] as string; slot.model = entry['model'] as string; slot.fallbackAlways = entry['fallbackAlways'] === true;
            if (slot.instanceId && slot.model) session.modelQueue.push(slot);
          }
        }
      }
      const archive = sessionArchiveFromJson(obj, true);
      session.messages = archive ? archive.messages : [];
      const wrote = this.hydrateImages(context, session.messages);
      this.fillImageBytes(context, session.messages);
      this.cache.set(session.id, session);
      if (wrote) {
        this.persist(context, session);
      }
      return session;
    } catch (err) {
      this.lastError = `${err}`;
      return null;
    }
  }

  static memoryAllowed(context: common.Context, id: string): boolean {
    if (!SessionStore.validId(id)) return true;
    const path = SessionStore.sessionPath(context, id);
    try {
      if (!fileIo.accessSync(path)) return false;
      const data = JSON.parse(fileIo.readTextSync(path)) as Record<string, Object>;
      return data['memoryEnabled'] !== false;
    } catch (_error) { return false; }
  }

  async setMemoryEnabled(context: common.Context, id: string, enabled: boolean): Promise<void> {
    const session = await this.get(context, id); if (!session || this.jsonLoadFailed) throw new Error('会话档案不可写');
    const before = session.memoryEnabled; const previousTime = session.updatedAt; session.memoryEnabled = enabled; session.updatedAt = Date.now();
    try { this.persist(context, session); } catch (error) { session.memoryEnabled = before; session.updatedAt = previousTime; throw error as Error; }
  }

  async bindModels(context: common.Context, id: string, queue: FailoverSlot[], groupId: string = ''): Promise<void> {
    const session = await this.get(context, id);
    if (!session || this.jsonLoadFailed) throw new Error('这个对话不可写');
    const previous = session.modelQueue; const previousTime = session.updatedAt; session.updatedAt = Date.now(); const previousGroup = session.modelGroupId; session.modelGroupId = groupId;
    const unresolved = session.unresolvedModelId;
    session.unresolvedModelId = '';
    session.modelQueue = queue.map((entry: FailoverSlot) => {
      const slot = new FailoverSlot(); slot.instanceId = entry.instanceId; slot.model = entry.model; slot.fallbackAlways = entry.fallbackAlways; return slot;
    });
    try { this.persist(context, session); } catch (err) { session.modelQueue = previous; session.updatedAt = previousTime; session.modelGroupId = previousGroup; session.unresolvedModelId = unresolved; throw err as Error; }
  }

  async append(context: common.Context, id: string, role: string, text: string,
    imageB64: string = '', imageMime: string = '', imagePath: string = ''): Promise<void> {
    const line = new LocalChatMessage();
    line.role = role;
    line.text = text;
    line.imageB64 = imageB64;
    line.imageMime = imageMime;
    line.imagePath = imagePath;
    await this.appendLine(context, id, line);
  }

  /** 追加一条完整的消息(带 kind、附件清单)。 */
  async appendLine(context: common.Context, id: string, line: LocalChatMessage, isCurrent: () => boolean = () => true): Promise<void> {
    const session = await this.get(context, id);
    if (!session) {
      throw new Error('对话不存在');
    }
    if (!isCurrent()) return;
    this.assertWritable();
    line.images = chatImages(line.images, line.imageB64, line.imageMime, line.imagePath);
    for (const media of line.images) if (!media.path) media.path = SessionStore.writeImageB64(context, media.b64, media.mime);
    SessionStore.firstImage(line);
    if (line.at <= 0) {
      line.at = Date.now();
    }
    session.messages = session.messages.concat([line]);
    if (session.title === '新任务' && line.role === 'user' && line.kind === '') {
      session.title = titleFromPrompt(line.text);
    }
    session.lastMessage = line.text;
    session.updatedAt = Date.now();
    this.upsertSummary(session);
    this.persist(context, session);
  }

  async setRunning(context: common.Context, id: string, on: boolean): Promise<void> {
    const session = await this.get(context, id);
    if (!session || session.running === on || this.jsonLoadFailed) {
      return;
    }
    session.running = on;
    this.persist(context, session);
  }

  /**
   * 重新从磁盘读。后台定时任务(ScheduleWork)跑在另一个进程里,会直接写对话档案;
   * App 回到前台时丢掉内存里的旧副本,免得下次保存把它写的内容盖掉。
   */
  async reload(context: common.Context): Promise<void> {
    this.loaded = false;
    this.pending = null;
    this.cache.clear();
    await this.ensureLoaded(context);
  }

  async replaceMessages(context: common.Context, session: LocalSession, updateModified: boolean = true): Promise<void> {
    await this.ensureLoaded(context);
    this.assertWritable();
    if (updateModified) session.updatedAt = Date.now();
    this.cache.set(session.id, session);
    this.upsertSummary(session);
    this.persist(context, session);
  }

  async archive(context: common.Context, id: string): Promise<void> {
    const session = await this.get(context, id);
    if (!session) {
      return;
    }
    this.assertWritable();
    session.archived = true;
    session.updatedAt = Date.now();
    this.upsertSummary(session);
    this.persist(context, session);
  }

  async remove(context: common.Context, id: string): Promise<void> {
    await this.ensureLoaded(context);
    this.assertWritable();
    if (!SessionStore.validId(id)) {
      return;
    }
    const doomed = await this.get(context, id);
    this.summaries = this.summaries.filter((row: LocalSessionSummary) => row.id !== id);
    this.cache.delete(id);
    const path = SessionStore.sessionPath(context, id);
    if (fileIo.accessSync(path)) {
      fileIo.unlinkSync(path);
    }
    SessionStore.writeText(SessionStore.indexPath(context), JSON.stringify(this.summaries));
    if (doomed) {
      this.dropImages(context, doomed.messages);
    }
  }

  /** 删掉这条对话自己的图片;「复制对话」的副本和它共用图片文件,还有别的对话引用的就留着。 */
  private dropImages(context: common.Context, messages: LocalChatMessage[]): void {
    const paths = messages.flatMap((line: LocalChatMessage) => chatImages(line.images, line.imageB64, line.imageMime, line.imagePath).map((media: ChatImage) => media.path))
      .filter((path: string) => SessionStore.ownedImage(context, path));
    if (paths.length === 0) {
      return;
    }
    const others: string[] = [];
    for (let i = 0; i < this.summaries.length; i++) {
      try {
        others.push(fileIo.readTextSync(SessionStore.sessionPath(context, this.summaries[i].id)));
      } catch (_err) {
        // 读不到其它档案时不能证明图片无人引用，保留附件。
        return;
      }
    }
    for (let i = 0; i < paths.length; i++) {
      if (others.some((text: string) => text.indexOf(paths[i]) >= 0)) {
        continue;
      }
      try {
        fileIo.unlinkSync(paths[i]);
      } catch (_err) {
        // 已经不在了
      }
    }
  }

  async rename(context: common.Context, id: string, title: string): Promise<void> {
    const session = await this.get(context, id);
    if (!session) {
      return;
    }
    this.assertWritable();
    const next = title.trim();
    if (next.length > 0) {
      session.title = next;
    }
    this.upsertSummary(session);
    this.persist(context, session);
  }

  async duplicate(context: common.Context, id: string): Promise<LocalSession> {
    const src = await this.get(context, id);
    if (!src) {
      throw new Error('对话不存在');
    }
    const copy = await this.create(context);
    copy.title = `${src.title} 副本`;
    copy.modelQueue = src.modelQueue.slice(); copy.modelGroupId = src.modelGroupId;
    copy.memoryEnabled = src.memoryEnabled; copy.unresolvedModelId = src.unresolvedModelId;
    copy.messages = src.messages.map((row: LocalChatMessage) => {
      const line = new LocalChatMessage(); line.role = row.role; line.text = row.text;
      line.imageB64 = row.imageB64; line.imageMime = row.imageMime; line.imagePath = row.imagePath;
      line.images = JSON.parse(JSON.stringify(chatImages(row.images, row.imageB64, row.imageMime, row.imagePath))) as ChatImage[];
      line.kind = row.kind; line.count = row.count; line.at = row.at; line.files = row.files.slice();
      line.syncPartsJson = row.syncPartsJson; line.syncText = row.syncText; line.syncId = ''; line.submissionId = ''; return line;
    });
    copy.lastMessage = src.lastMessage;
    copy.updatedAt = Date.now();
    this.upsertSummary(copy);
    this.persist(context, copy);
    return copy;
  }

  async togglePin(context: common.Context, id: string): Promise<void> {
    const session = await this.get(context, id);
    if (!session) {
      return;
    }
    this.assertWritable();
    session.pinned = !session.pinned;
    this.upsertSummary(session);
    this.persist(context, session);
  }

  /** 一条对话导出成「导入对话」认的档案(不带图片,图片太大)。 */
  async exportSession(context: common.Context, id: string): Promise<string> {
    const session = await this.get(context, id);
    if (!session) {
      throw new Error('对话不存在');
    }
    return sessionArchiveJson(session.title, session.messages);
  }

  async importArchive(context: common.Context, raw: string): Promise<LocalSession> {
    await this.ensureLoaded(context);
    this.assertWritable();
    if (raw.length > 32 * 1024 * 1024) throw new Error('导入档案过大');
    let json: object;
    try {
      json = JSON.parse(raw) as object;
    } catch (_err) {
      throw new Error('不是 JSON');
    }
    const archive = sessionArchiveFromJson(json);
    if (!archive) {
      throw new Error('导入只接受带 messages 的档案');
    }
    // 外部档案只接收经过验证的图片字节，不接受另一台设备的宿主路径。
    for (let i = 0; i < archive.messages.length; i++) {
      const line = archive.messages[i];
      line.imagePath = '';
      line.images = chatImages(line.images, line.imageB64, line.imageMime);
      for (const media of line.images) {
        media.path = ''; const validation = new LocalChatMessage(); validation.imageB64 = media.b64; validation.imageMime = media.mime;
        if (media.b64) await SessionStore.validateImportedImage(validation);
      }
      SessionStore.firstImage(line);
    }
    const session = await this.create(context);
    session.title = archive.title;
    session.messages = archive.messages;
    this.hydrateImages(context, session.messages);
    session.updatedAt = Date.now();
    this.upsertSummary(session);
    this.persist(context, session);
    return session;
  }

  private static firstImage(line: LocalChatMessage): void {
    const first = line.images[0]; line.imageB64 = first?.b64 ?? ''; line.imageMime = first?.mime ?? ''; line.imagePath = first?.path ?? '';
  }

  private fillImageBytes(context: common.Context, messages: LocalChatMessage[]): void {
    for (const line of messages) {
      line.images = chatImages(line.images, line.imageB64, line.imageMime, line.imagePath);
      for (const media of line.images) {
        if (media.path && !SessionStore.ownedImage(context, media.path)) { media.path = ''; media.b64 = ''; }
        if (media.b64 || !media.path || !fileIo.accessSync(media.path)) continue;
        try {
          const file = fileIo.openSync(media.path, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW);
          try {
            const stat = fileIo.statSync(file.fd);
            if (!stat.isFile() || stat.size <= 0 || stat.size > SessionStore.MAX_IMAGE_BYTES) continue;
            const buf = new ArrayBuffer(stat.size);
            if (fileIo.readSync(file.fd, buf) === stat.size) media.b64 = new util.Base64Helper().encodeToStringSync(new Uint8Array(buf));
          } finally { fileIo.closeSync(file); }
        } catch (_error) { /* A missing attachment leaves other images and text available. */ }
      }
      SessionStore.firstImage(line);
    }
  }

  private hydrateImages(context: common.Context, messages: LocalChatMessage[]): boolean {
    let changed = false;
    for (const line of messages) {
      line.images = chatImages(line.images, line.imageB64, line.imageMime, line.imagePath);
      for (const media of line.images) {
        if (SessionStore.ownedImage(context, media.path)) continue;
        if (media.path) { media.path = ''; changed = true; }
        if (!media.b64) continue;
        media.path = SessionStore.writeImageB64(context, media.b64, media.mime);
        if (media.path) changed = true;
      }
      SessionStore.firstImage(line);
    }
    return changed;
  }

  private static readonly MAX_IMAGE_BYTES: number = 8 * 1024 * 1024;
  private static readonly MAX_IMAGE_PIXELS: number = 24 * 1024 * 1024;

  /** 附件必须是本机生成的平面文件；根目录和叶子都不能是符号链接。 */
  private static ownedImage(context: common.Context, path: string): boolean {
    const root = context.filesDir + '/chat-images';
    if (!path.startsWith(root + '/')) return false;
    const name = path.substring(root.length + 1);
    if (!/^(?:\d+(_\d+)?|generated-[a-f0-9-]{32,36})\.(jpg|png)$/i.test(name)) return false;
    try {
      const dir = fileIo.lstatSync(root);
      const file = fileIo.lstatSync(path);
      return dir.isDirectory() && !dir.isSymbolicLink() && file.isFile() && !file.isSymbolicLink();
    } catch (_err) {
      return false;
    }
  }

  private static async validateImportedImage(line: LocalChatMessage): Promise<void> {
    if (line.imageB64.length > SessionStore.MAX_IMAGE_BYTES * 4 / 3 + 4 ||
      (line.imageMime !== 'image/jpeg' && line.imageMime !== 'image/png')) throw new Error('导入图片格式或大小不受支持');
    const bytes = new util.Base64Helper().decodeSync(line.imageB64);
    if (bytes.byteLength === 0 || bytes.byteLength > SessionStore.MAX_IMAGE_BYTES) throw new Error('导入图片过大');
    const png = bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 &&
      bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10;
    const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if ((line.imageMime === 'image/png' && !png) || (line.imageMime === 'image/jpeg' && !jpeg)) {
      throw new Error('导入图片内容与格式不符');
    }
    const source = image.createImageSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    try {
      const info = await source.getImageInfo();
      if (info.size.width <= 0 || info.size.height <= 0 ||
        info.size.width * info.size.height > SessionStore.MAX_IMAGE_PIXELS) throw new Error('导入图片像素过多');
    } finally {
      await source.release();
    }
  }

  static writeImageBytes(context: common.Context, buf: ArrayBuffer, mime: string): string {
    if (buf.byteLength <= 0 || buf.byteLength > SessionStore.MAX_IMAGE_BYTES) throw new Error('图片过大');
    const dir = context.filesDir + '/chat-images';
    SessionStore.ensureDir(dir);
    const dirStat = fileIo.lstatSync(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('图片目录不安全');
    const ext = mime.indexOf('png') >= 0 ? 'png' : 'jpg';
    // 原来文件名只有 Date.now()。hydrateImages 是一个同步 for 循环，
    // 连着两张图很容易落在同一毫秒，第二张直接覆盖第一张，两条消息指向同一个文件。
    // 导入带多张图的档案时必现。加随机后缀。
    const path = `${dir}/${Date.now()}_${Math.floor(Math.random() * 1000000)}.${ext}`;
    const file = fileIo.openSync(path,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC | fileIo.OpenMode.NOFOLLOW);
    try {
      if (fileIo.writeSync(file.fd, buf) !== buf.byteLength) throw new Error('图片写入不完整');
      fileIo.fsyncSync(file.fd);
    } finally {
      fileIo.closeSync(file);
    }
    return path;
  }

  static writeImageB64(context: common.Context, raw: string, mime: string): string {
    if (raw.length === 0 || raw.length > SessionStore.MAX_IMAGE_BYTES * 4 / 3 + 4) {
      return '';
    }
    try {
      const helper = new util.Base64Helper();
      const bytes = helper.decodeSync(raw);
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return SessionStore.writeImageBytes(context, buf, mime);
    } catch (_err) {
      return '';
    }
  }

  private persist(context: common.Context, session: LocalSession): void {
    SessionStore.ensureDir(SessionStore.dir(context));
    if (session.messages.length > 0) {
      session.lastMessage = session.messages[session.messages.length - 1].text;
    }
    const held: string[] = [];
    const mediaBytes: string[][] = [];
    for (let i = 0; i < session.messages.length; i++) {
      const line = session.messages[i]; line.images = chatImages(line.images, line.imageB64, line.imageMime, line.imagePath);
      mediaBytes.push(line.images.map((media: ChatImage) => media.b64));
      for (const media of line.images) if (media.path) media.b64 = '';
      held.push(session.messages[i].imageB64);
      if (session.messages[i].imagePath.length > 0) {
        session.messages[i].imageB64 = '';
      }
    }
    try {
      const body = JSON.stringify(session);
      SessionStore.writeText(SessionStore.sessionPath(context, session.id), body);
      const index = JSON.stringify(this.summaries);
      SessionStore.writeText(SessionStore.indexPath(context), index);
    } finally {
      for (let i = 0; i < session.messages.length; i++) {
        session.messages[i].imageB64 = held[i];
        for (let j = 0; j < session.messages[i].images.length; j++) session.messages[i].images[j].b64 = mediaBytes[i][j];
      }
    }
  }

  private upsertSummary(session: LocalSession): void {
    session.lastMessage = session.messages.length > 0 ? session.messages[session.messages.length - 1].text : '';
    let found = false;
    for (let i = 0; i < this.summaries.length; i++) {
      if (this.summaries[i].id === session.id) {
        this.summaries[i].title = session.title;
        this.summaries[i].lastMessage = session.lastMessage;
        this.summaries[i].updatedAt = session.updatedAt;
        this.summaries[i].archived = session.archived;
        this.summaries[i].pinned = session.pinned;
        found = true;
        break;
      }
    }
    if (!found) {
      const summary = new LocalSessionSummary();
      summary.id = session.id;
      summary.title = session.title;
      summary.lastMessage = session.lastMessage;
      summary.updatedAt = session.updatedAt;
      summary.archived = session.archived;
      summary.pinned = session.pinned;
      this.summaries = [summary].concat(this.summaries);
    } else {
      this.summaries.sort((a: LocalSessionSummary, b: LocalSessionSummary) => b.updatedAt - a.updatedAt);
    }
  }

  private assertWritable(): void {
    if (this.jsonLoadFailed) {
      throw new Error('对话档案读坏了，先别保存，避免覆盖');
    }
  }

  private static dir(context: common.Context): string {
    return context.filesDir + '/sessions';
  }

  private static indexPath(context: common.Context): string {
    return SessionStore.dir(context) + '/index.json';
  }

  private static sessionPath(context: common.Context, id: string): string {
    if (!SessionStore.validId(id)) {
      throw new Error('对话编号不对');
    }
    return SessionStore.dir(context) + '/' + id + '.json';
  }

  private static ensureDir(path: string): void {
    if (!fileIo.accessSync(path)) {
      fileIo.mkdirSync(path);
    }
  }

  /** 先写临时文件再改名:写到一半被杀掉,旧档案还是完整的。 */
  private static writeText(path: string, text: string): void {
    atomicWriteText(path, text);
  }
}

export const sessionStore: SessionStore = new SessionStore();
