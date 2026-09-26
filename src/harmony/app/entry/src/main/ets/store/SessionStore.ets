import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import {
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
    if (!fileIo.accessSync(indexPath)) {
      this.summaries = [];
      this.loaded = true;
      return;
    }
    try {
      const raw = fileIo.readTextSync(indexPath);
      const parsed = JSON.parse(raw) as Object[];
      if (!Array.isArray(parsed)) {
        throw new Error('index not array');
      }
      this.summaries = parsed.map((row: Object) => {
        const item = row as Record<string, Object>;
        const summary = new LocalSessionSummary();
        summary.id = `${item['id'] ?? ''}`;
        summary.title = `${item['title'] ?? '新任务'}`;
        summary.lastMessage = `${item['lastMessage'] ?? ''}`;
        summary.updatedAt = Number(item['updatedAt'] ?? 0);
        summary.archived = item['archived'] === true;
        summary.pinned = item['pinned'] === true;
        return summary;
      }).filter((row: LocalSessionSummary) => row.id.length > 0);
    } catch (err) {
      this.jsonLoadFailed = true;
      this.lastError = `${err}`;
      this.summaries = [];
    }
    this.loaded = true;
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
    if (!id) {
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
      const archive = sessionArchiveFromJson(obj);
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
  async appendLine(context: common.Context, id: string, line: LocalChatMessage): Promise<void> {
    const session = await this.get(context, id);
    if (!session) {
      throw new Error('对话不存在');
    }
    this.assertWritable();
    if (line.imagePath.length === 0) {
      line.imagePath = SessionStore.writeImageB64(context, line.imageB64, line.imageMime);
    }
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

  async replaceMessages(context: common.Context, session: LocalSession): Promise<void> {
    await this.ensureLoaded(context);
    this.assertWritable();
    session.updatedAt = Date.now();
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
    this.summaries = this.summaries.filter((row: LocalSessionSummary) => row.id !== id);
    this.cache.delete(id);
    const path = SessionStore.sessionPath(context, id);
    if (fileIo.accessSync(path)) {
      fileIo.unlinkSync(path);
    }
    SessionStore.writeText(SessionStore.indexPath(context), JSON.stringify(this.summaries));
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
    copy.messages = src.messages.slice();
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
    const session = await this.create(context);
    session.title = archive.title;
    session.messages = archive.messages;
    session.updatedAt = Date.now();
    this.upsertSummary(session);
    this.persist(context, session);
    return session;
  }

  private fillImageBytes(context: common.Context, messages: LocalChatMessage[]): void {
    for (let i = 0; i < messages.length; i++) {
      const line = messages[i];
      if (line.imageB64.length > 0 || line.imagePath.length === 0) {
        continue;
      }
      if (!fileIo.accessSync(line.imagePath)) {
        continue;
      }
      try {
        const file = fileIo.openSync(line.imagePath, fileIo.OpenMode.READ_ONLY);
        try {
          const stat = fileIo.statSync(line.imagePath);
          const buf = new ArrayBuffer(stat.size);
          fileIo.readSync(file.fd, buf);
          const helper = new util.Base64Helper();
          line.imageB64 = helper.encodeToStringSync(new Uint8Array(buf));
        } finally {
          fileIo.closeSync(file);
        }
      } catch (_err) {
        // keep the path; chat can still show the file
      }
    }
  }

  private hydrateImages(context: common.Context, messages: LocalChatMessage[]): boolean {
    let changed = false;
    for (let i = 0; i < messages.length; i++) {
      const line = messages[i];
      if (line.imagePath.length > 0 && fileIo.accessSync(line.imagePath)) {
        continue;
      }
      if (line.imageB64.length === 0) {
        continue;
      }
      line.imagePath = SessionStore.writeImageB64(context, line.imageB64, line.imageMime);
      if (line.imagePath.length > 0) {
        changed = true;
      }
    }
    return changed;
  }

  static writeImageBytes(context: common.Context, buf: ArrayBuffer, mime: string): string {
    const dir = context.filesDir + '/chat-images';
    SessionStore.ensureDir(dir);
    const ext = mime.indexOf('png') >= 0 ? 'png' : 'jpg';
    // 原来文件名只有 Date.now()。hydrateImages 是一个同步 for 循环，
    // 连着两张图很容易落在同一毫秒，第二张直接覆盖第一张，两条消息指向同一个文件。
    // 导入带多张图的档案时必现。加随机后缀。
    const path = `${dir}/${Date.now()}_${Math.floor(Math.random() * 1000000)}.${ext}`;
    const file = fileIo.openSync(path,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    try {
      fileIo.writeSync(file.fd, buf);
    } finally {
      fileIo.closeSync(file);
    }
    return path;
  }

  static writeImageB64(context: common.Context, raw: string, mime: string): string {
    if (raw.length === 0) {
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
    for (let i = 0; i < session.messages.length; i++) {
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
      }
    }
  }

  private upsertSummary(session: LocalSession): void {
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
    return SessionStore.dir(context) + '/' + id + '.json';
  }

  private static ensureDir(path: string): void {
    if (!fileIo.accessSync(path)) {
      fileIo.mkdirSync(path);
    }
  }

  private static writeText(path: string, text: string): void {
    const file = fileIo.openSync(path,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    try {
      fileIo.writeSync(file.fd, text);
    } finally {
      fileIo.closeSync(file);
    }
  }
}

export const sessionStore: SessionStore = new SessionStore();
