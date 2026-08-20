import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';

export class ScheduleTask {
  rowId: string = '';
  title: string = '';
  prompt: string = '';
  hour: number = 9;
  minute: number = 0;
  on: boolean = true;
  lastDay: string = '';
  sessionId: string = '';
  lastRunAt: number = 0;
  lastResult: string = '';
  lastError: string = '';
}

class ScheduleFile {
  rows: ScheduleTask[] = [];
}

export class ScheduleStore {
  rows: ScheduleTask[] = [];
  jsonLoadFailed: boolean = false;
  running: boolean = false;
  lastTick: number = 0;
  private loaded: boolean = false;

  async load(context: common.UIAbilityContext): Promise<void> {
    if (this.loaded) {
      return;
    }
    const path = context.filesDir + '/schedule.json';
    if (fileIo.accessSync(path)) {
      try {
        const obj = JSON.parse(fileIo.readTextSync(path)) as Record<string, Object>;
        this.rows = ScheduleStore.parse(obj['rows']);
      } catch (_err) {
        this.jsonLoadFailed = true;
        this.rows = [];
      }
    }
    this.loaded = true;
  }

  async save(context: common.UIAbilityContext): Promise<void> {
    if (this.jsonLoadFailed) {
      throw new Error('定时任务档案读坏了，先别保存');
    }
    const body = new ScheduleFile();
    body.rows = this.rows;
    const path = context.filesDir + '/schedule.json';
    const file = fileIo.openSync(path,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    try {
      fileIo.writeSync(file.fd, JSON.stringify(body));
    } finally {
      fileIo.closeSync(file);
    }
  }

  async upsert(context: common.UIAbilityContext, title: string, prompt: string, hour: number,
    minute: number): Promise<void> {
    const name = title.trim();
    const text = prompt.trim();
    if (!name || !text) {
      throw new Error('标题和提示词不能空');
    }
    // 页面传进来的是 Number(输入框文本)，输入 'abc' 就是 NaN。
    // NaN 参与的比较全是 false，原来那三个范围判断等于没做：
    // NaN 会一路存进去，dueNow 里 fire.setHours(NaN) 得到 Invalid Date，
    // fireAt 是 NaN，比较又全 false —— 这条任务当次运行永远不触发，用户还以为设好了。
    if (!Number.isFinite(hour) || !Number.isFinite(minute) ||
      hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error('时间不合法');
    }
    hour = Math.floor(hour);
    minute = Math.floor(minute);
    let row: ScheduleTask | null = null;
    for (let i = 0; i < this.rows.length; i++) {
      if (this.rows[i].title === name) {
        row = this.rows[i];
      }
    }
    if (!row) {
      row = new ScheduleTask();
      row.rowId = `sch_${Date.now()}`;
      row.title = name;
      this.rows = this.rows.concat([row]);
    }
    row.prompt = text;
    row.hour = hour;
    row.minute = minute;
    row.on = true;
    await this.save(context);
  }

  async remove(context: common.UIAbilityContext, rowId: string): Promise<void> {
    const next: ScheduleTask[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      if (this.rows[i].rowId !== rowId) {
        next.push(this.rows[i]);
      }
    }
    this.rows = next;
    await this.save(context);
  }

  dueNow(): ScheduleTask[] {
    const now = Date.now();
    const today = ScheduleStore.dayKey(now);
    const windowStart = this.lastTick > 0 ? this.lastTick : now - 60000;
    this.lastTick = now;
    const out: ScheduleTask[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      if (!row.on || row.lastDay === today) {
        continue;
      }
      const fire = new Date(now);
      fire.setHours(row.hour, row.minute, 0, 0);
      const fireAt = fire.getTime();
      if (fireAt > windowStart && fireAt <= now) {
        out.push(row);
      }
    }
    return out;
  }

  private static dayKey(stamp: number): string {
    const date = new Date(stamp);
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }

  async mark(context: common.UIAbilityContext, rowId: string): Promise<void> {
    const now = new Date();
    const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    for (let i = 0; i < this.rows.length; i++) {
      if (this.rows[i].rowId === rowId) {
        this.rows[i].lastDay = today;
      }
    }
    await this.save(context);
  }

  static sessionTitle(title: string): string {
    const name = title.trim() || '任务';
    return `定时·${name}`;
  }

  static runLabel(row: ScheduleTask, now: number = Date.now()): string {
    if (row.lastError.trim().length > 0) {
      const cut = row.lastError.trim().length > 80 ? `${row.lastError.trim().substring(0, 80)}…` :
        row.lastError.trim();
      return `失败 · ${cut}`;
    }
    if (row.lastRunAt <= 0) {
      return '还没跑过';
    }
    const mins = Math.max(0, Math.floor((now - row.lastRunAt) / 60000));
    const when = mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : `${Math.floor(mins / 60)} 小时前`;
    const result = row.lastResult.trim().length > 40 ? `${row.lastResult.trim().substring(0, 40)}…` :
      row.lastResult.trim();
    return result.length > 0 ? `上次 ${when} · ${result}` : `上次 ${when}`;
  }

  async record(context: common.UIAbilityContext, rowId: string, sessionId: string, result: string,
    error: string): Promise<void> {
    for (let i = 0; i < this.rows.length; i++) {
      if (this.rows[i].rowId === rowId) {
        this.rows[i].sessionId = sessionId;
        this.rows[i].lastRunAt = Date.now();
        this.rows[i].lastResult = result;
        this.rows[i].lastError = error;
        if (error.length === 0) {
          const now = new Date();
          this.rows[i].lastDay = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
        }
      }
    }
    await this.save(context);
  }

  private static clampTime(raw: Object | undefined, fallback: number, max: number): number {
    const value = Number(raw ?? fallback);
    if (!Number.isFinite(value) || value < 0 || value > max) {
      return fallback;
    }
    return Math.floor(value);
  }

  private static parse(raw: Object | undefined): ScheduleTask[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const out: ScheduleTask[] = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i] as Record<string, Object>;
      const row = new ScheduleTask();
      row.rowId = `${item['rowId'] ?? ''}`;
      row.title = `${item['title'] ?? ''}`.trim();
      row.prompt = `${item['prompt'] ?? ''}`;
      // 老档案里可能存进过 NaN（JSON 写出来是 null），读回来要落到默认值而不是再变 NaN
      row.hour = ScheduleStore.clampTime(item['hour'], 9, 23);
      row.minute = ScheduleStore.clampTime(item['minute'], 0, 59);
      row.on = item['on'] !== false;
      row.lastDay = `${item['lastDay'] ?? ''}`;
      row.sessionId = `${item['sessionId'] ?? ''}`;
      row.lastRunAt = Number(item['lastRunAt'] ?? 0);
      row.lastResult = `${item['lastResult'] ?? ''}`;
      row.lastError = `${item['lastError'] ?? ''}`;
      if (!row.rowId) {
        row.rowId = `sch_${i}_${Date.now()}`;
      }
      if (row.title.length > 0 && row.prompt.length > 0) {
        out.push(row);
      }
    }
    return out;
  }
}

export const scheduleStore: ScheduleStore = new ScheduleStore();
