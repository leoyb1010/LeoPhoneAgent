/**
 * Fast native intents. Same phrases as Android ActionRouter / protocol/actionRouter.ts.
 * ArkTS cannot import that Node file; keep the two copies in lockstep.
 */

export class ActionDecision {
  path: string = 'agent';
  kind: string = '';
  hour: number = -1;
  minute: number = -1;
  tomorrow: boolean = false;
  label: string = '';
}

export class ActionRouter {
  static decide(text: string, imageCount: number): ActionDecision {
    const raw = text.trim();
    const lower = raw.toLowerCase();
    if (imageCount > 0 && ActionRouter.isSavePhoto(lower)) {
      return ActionRouter.native('savePhoto', -1, -1, false, '');
    }
    const torch = ActionRouter.flashlightOn(lower);
    if (torch !== 0) {
      return ActionRouter.native('toggleFlashlight', -1, -1, false, torch > 0 ? 'on' : 'off');
    }
    if (ActionRouter.isTodo(lower)) {
      return ActionRouter.native('createTodo', -1, -1, false, ActionRouter.todoTitle(raw));
    }
    if (ActionRouter.isAlarm(raw, lower)) {
      const time = ActionRouter.parseTime(raw, lower);
      if (time.length < 2) {
        return new ActionDecision();
      }
      return ActionRouter.native('setAlarm', time[0], time[1], ActionRouter.isTomorrow(lower),
        ActionRouter.alarmLabel(raw));
    }
    if (ActionRouter.isCalendar(lower)) {
      const time = ActionRouter.parseTime(raw, lower);
      if (time.length < 2) {
        return new ActionDecision();
      }
      return ActionRouter.native('createCalendar', time[0], time[1], ActionRouter.isTomorrow(lower),
        ActionRouter.calendarTitle(raw));
    }
    return new ActionDecision();
  }

  static spoken(d: ActionDecision): string {
    if (d.kind === 'savePhoto') {
      return '已用系统相册保存，未打开界面。';
    }
    if (d.kind === 'setAlarm') {
      return `已用系统闹钟设定 ${ActionRouter.two(d.hour)}:${ActionRouter.two(d.minute)}，未打开界面。`;
    }
    if (d.kind === 'createCalendar') {
      return '已用系统日历创建日程，未打开界面。';
    }
    if (d.kind === 'toggleFlashlight') {
      return d.label === 'off' ? '已关掉手电筒。' : '已打开手电筒。';
    }
    if (d.kind === 'createTodo') {
      return `已记下待办：${d.label.length > 0 ? d.label : '待办'}。`;
    }
    return '';
  }

  static isSavePhoto(lower: string): boolean {
    return ActionRouter.hasAny(lower, [
      '相册', '相簿', 'save to album', 'save to photos',
      'save this photo', 'save this image', 'save the photo',
      'save the image', '存进相册', '保存到相册', '存到相册', '放到相册'
    ]);
  }

  static isCalendar(lower: string): boolean {
    return ActionRouter.hasAny(lower, [
      '加到日历', '写入日历', '添加到日历', '加进日历',
      'add to calendar', 'create calendar event', '创建日程'
    ]);
  }

  /** 1 = on, -1 = off, 0 = not a torch phrase. */
  static flashlightOn(lower: string): number {
    if (ActionRouter.hasAny(lower, [
      '关掉手电筒', '关闭手电筒', '关手电筒', '关上手电筒',
      'turn off flashlight', 'turn off the flashlight', 'turn off torch',
      'flashlight off', 'torch off'
    ])) {
      return -1;
    }
    if (ActionRouter.hasAny(lower, [
      '打开手电筒', '开手电筒', '打开手电', '开手电',
      'turn on flashlight', 'turn on the flashlight', 'turn on torch',
      'flashlight on', 'torch on'
    ])) {
      return 1;
    }
    return 0;
  }

  static isTodo(lower: string): boolean {
    return ActionRouter.hasAny(lower, [
      '记个待办', '记一条待办', '添加待办', '写个待办',
      'add a todo', 'add todo', 'remind me to'
    ]);
  }

  static isTomorrow(lower: string): boolean {
    return lower.indexOf('明早') >= 0 || lower.indexOf('明天') >= 0 ||
      lower.indexOf('tomorrow') >= 0 || lower.indexOf('tmrw') >= 0;
  }

  static isAlarm(raw: string, lower: string): boolean {
    if (ActionRouter.isCalendar(lower)) {
      return false;
    }
    const hit = lower.indexOf('闹钟') >= 0 ||
      /\bset alarm\b/.test(lower) ||
      /\balarm (for|at)\b/.test(lower);
    return hit && ActionRouter.parseTime(raw, lower).length === 2;
  }

  static parseTime(raw: string, lower: string): number[] {
    const colon = raw.match(/(\d{1,2})[:：](\d{2})/);
    if (colon && colon.index !== undefined) {
      const h = ActionRouter.adjustHour(Number(colon[1]), lower, colon.index);
      return ActionRouter.valid(h, Number(colon[2]));
    }
    const zh = raw.match(/(\d{1,2})\s*点\s*(\d{1,2})?\s*分?/);
    if (zh && zh.index !== undefined) {
      const h = ActionRouter.adjustHour(Number(zh[1]), lower, zh.index);
      const min = zh[2] ? Number(zh[2]) : 0;
      return ActionRouter.valid(h, min);
    }
    const ampm = lower.match(/\b(\d{1,2})\s*([ap])m\b/);
    if (ampm) {
      let h = Number(ampm[1]);
      if (ampm[2] === 'p' && h < 12) {
        h += 12;
      }
      if (ampm[2] === 'a' && h === 12) {
        h = 0;
      }
      return ActionRouter.valid(h, 0);
    }
    return [];
  }

  private static native(kind: string, hour: number, minute: number, tomorrow: boolean,
    label: string): ActionDecision {
    const d = new ActionDecision();
    d.path = 'native';
    d.kind = kind;
    d.hour = hour;
    d.minute = minute;
    d.tomorrow = tomorrow;
    d.label = label;
    return d;
  }

  private static hasAny(lower: string, needles: string[]): boolean {
    for (let i = 0; i < needles.length; i++) {
      if (lower.indexOf(needles[i]) >= 0) {
        return true;
      }
    }
    return false;
  }

  private static adjustHour(hour: number, lower: string, at: number): number {
    const prefix = lower.substring(0, Math.min(at, lower.length));
    const morning = prefix.indexOf('早') >= 0 || prefix.indexOf('上午') >= 0 || prefix.indexOf('am') >= 0;
    const evening = prefix.indexOf('晚') >= 0 || prefix.indexOf('下午') >= 0 || prefix.indexOf('pm') >= 0;
    if (evening && hour >= 1 && hour <= 11) {
      return hour + 12;
    }
    if (morning && hour === 12) {
      return 0;
    }
    return hour;
  }

  private static valid(hour: number, minute: number): number[] {
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return [hour, minute];
    }
    return [];
  }

  private static two(n: number): string {
    if (n < 0) {
      return '--';
    }
    return n < 10 ? `0${n}` : `${n}`;
  }

  private static strip(raw: string, re: RegExp): string {
    return raw.replace(re, '').replace(/^[\s，,。.：:]+|[\s，,。.：:]+$/g, '');
  }

  private static alarmLabel(raw: string): string {
    const out = ActionRouter.strip(raw, /明早|明天|tomorrow|tmrw|闹钟|set alarm|alarm for|alarm at/gi);
    const noTime = ActionRouter.strip(out, /\d{1,2}[:：]\d{2}/).replace(/\d{1,2}\s*点\s*\d{0,2}\s*分?/g, '').trim();
    return noTime.length > 0 ? noTime : '闹钟';
  }

  private static calendarTitle(raw: string): string {
    const out = ActionRouter.strip(raw,
      /加到日历|写入日历|添加到日历|加进日历|add to calendar|create calendar event|创建日程/gi);
    const noDay = ActionRouter.strip(out, /明早|明天|tomorrow|tmrw/gi);
    const noTime = ActionRouter.strip(noDay, /\d{1,2}[:：]\d{2}/).replace(/\d{1,2}\s*点\s*\d{0,2}\s*分?/g, '').trim();
    return noTime.length > 0 ? noTime : '日程';
  }

  private static todoTitle(raw: string): string {
    const out = ActionRouter.strip(raw,
      /记个待办|记一条待办|添加待办|写个待办|add a todo|add todo|remind me to/gi);
    return out.length > 0 ? out : '待办';
  }
}
