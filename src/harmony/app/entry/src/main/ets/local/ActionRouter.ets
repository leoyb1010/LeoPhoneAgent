/**
 * Fast native intents. Same phrases as Android ActionRouter / iOS AgentChatCorrectness and
 * protocol/actionRouter.ts. ArkTS cannot import that Node file; keep the two copies in lockstep.
 *
 * path: native = do it without the model; clarify = ask only for what's missing (never let a model
 * guess a time or a train number); agent = hand the text to the model.
 * Harmony can't read the clipboard (restricted permission), so 「读剪贴板」 goes to the model.
 */

export class ActionDecision {
  path: string = 'agent';
  kind: string = '';
  hour: number = -1;
  minute: number = -1;
  tomorrow: boolean = false;
  dayOffset: number = 0;
  label: string = '';
  location: string = '';
  notes: string = '';
  missing: string[] = [];
}

const CJK_WORD: string = '一-龥A-Za-z';

export class ActionRouter {
  static decide(text: string, imageCount: number, today: Date = new Date()): ActionDecision {
    const raw = text.trim();
    const lower = raw.toLowerCase();
    if (imageCount > 0 && ActionRouter.isSavePhoto(lower)) {
      return ActionRouter.make('native', 'savePhoto');
    }
    const copy = ActionRouter.clipboardWriteText(raw);
    if (copy.length > 0) {
      const d = ActionRouter.make('native', 'writeClipboard');
      d.label = copy;
      return d;
    }
    if (ActionRouter.isDeviceInfo(lower)) {
      return ActionRouter.make('native', 'deviceInfo');
    }
    const torch = ActionRouter.flashlightOn(lower);
    if (torch !== 0) {
      const d = ActionRouter.make('native', 'toggleFlashlight');
      d.label = torch > 0 ? 'on' : 'off';
      return d;
    }
    const travel = ActionRouter.parseTravel(raw, lower, today);
    if (travel) {
      return travel;
    }
    if (ActionRouter.isTodo(lower)) {
      const title = ActionRouter.todoTitle(raw);
      const d = ActionRouter.make(title.length > 0 ? 'native' : 'clarify', 'createTodo');
      ActionRouter.withTime(d, raw, lower, today);
      d.label = title;
      d.notes = `原始指令：${raw}`;
      if (title.length === 0) {
        d.missing = ['要提醒的事情'];
      }
      return d;
    }
    if (ActionRouter.isAlarm(raw, lower)) {
      const d = ActionRouter.make('native', 'setAlarm');
      ActionRouter.withTime(d, raw, lower, today);
      d.label = ActionRouter.alarmLabel(raw);
      return d;
    }
    if (ActionRouter.isCalendar(lower)) {
      const time = ActionRouter.parseTime(raw, lower);
      const d = ActionRouter.make(time.length === 2 ? 'native' : 'clarify', 'createCalendar');
      ActionRouter.withTime(d, raw, lower, today);
      d.label = ActionRouter.calendarTitle(raw);
      d.location = ActionRouter.extractLocation(raw);
      d.notes = `原始指令：${raw}`;
      if (time.length !== 2) {
        d.missing = ['开始时间'];
      }
      return d;
    }
    return new ActionDecision();
  }

  /** 出行记录:缺的信息只追问,不交给模型去猜时间或车次。 */
  static parseTravel(raw: string, lower: string, today: Date = new Date()): ActionDecision | null {
    const vehicles = ['高铁', '动车', '火车', '航班', '飞机', '客车', '大巴', '轮船', '行程', 'train', 'flight', 'bus', 'trip'];
    let vehicle = '';
    for (let i = 0; i < vehicles.length; i++) {
      if (lower.indexOf(vehicles[i]) >= 0) {
        vehicle = vehicles[i];
        break;
      }
    }
    if (vehicle.length === 0 || !ActionRouter.hasAny(lower,
      ['记录', '记下', '记一下', '提醒', '行程', '日历', '别忘', 'record', 'remind', 'schedule'])) {
      return null;
    }
    const time = ActionRouter.parseTime(raw, lower);
    const dest = new RegExp(`(?:去|到)\\s*([${CJK_WORD}]{2,16}?)(?:的)?(?:高铁|动车|火车|航班|飞机|客车|大巴|轮船|行程|[，,。\\s])`).exec(raw);
    const destination = dest ? dest[1].trim() : '';
    const trainHit = /\b([A-Z]{1,3}\s*\d{1,5})\b/i.exec(raw);
    const train = trainHit ? trainHit[1].replace(/\s/g, '').toUpperCase() : '';
    const seatHit = /座位(?:是|号|[：:])?\s*([0-9]{1,2}[A-Fa-f]|[0-9]{1,2}车(?:厢)?[0-9]{1,3}[A-Fa-f]?号?)/.exec(raw);
    const seat = seatHit ? seatHit[1].trim() : '';
    const missing: string[] = [];
    if (time.length !== 2) {
      missing.push('开车时间');
    }
    if (destination.length === 0 && train.length === 0) {
      missing.push('目的地或车次/航班号');
    }
    if (train.length === 0 && /(?:车次|航班)(?:是|号|[：:])?\s*(?:[，,。]|$)/.test(raw)) {
      missing.push('车次');
    }
    if (seat.length === 0 && /座位(?:是|号|[：:])?\s*(?:[，,。]|$)/.test(raw)) {
      missing.push('座位');
    }
    const notes: string[] = [];
    if (train.length > 0) {
      notes.push(`车次：${train}`);
    }
    if (seat.length > 0) {
      notes.push(`座位：${seat}`);
    }
    notes.push(`原始指令：${raw}`);
    notes.push('未提供的信息保持为空，不做推断。');
    const d = ActionRouter.make(missing.length === 0 ? 'native' : 'clarify', 'createTravel');
    ActionRouter.withTime(d, raw, lower, today);
    d.label = [destination, vehicle, train].filter((part: string) => part.length > 0).join(' ');
    d.location = destination;
    d.notes = notes.join('\n');
    d.missing = missing;
    return d;
  }

  static spoken(d: ActionDecision): string {
    const hhmm = `${ActionRouter.two(d.hour)}:${ActionRouter.two(d.minute)}`;
    if (d.path === 'clarify') {
      const what = d.kind === 'createTravel' ? '出行记录' : (d.kind === 'createCalendar' ? '日程' : '提醒');
      return `我已识别为${what}，还需要：${d.missing.join('、')}。`;
    }
    if (d.kind === 'savePhoto') {
      return '已用系统相册保存，未打开界面。';
    }
    if (d.kind === 'setAlarm') {
      return `已用系统闹钟设定 ${hhmm}，未打开界面。`;
    }
    if (d.kind === 'createCalendar') {
      // 鸿蒙上是系统提醒,不是日历日程(读写整个日历要受限权限),如实说。
      return `已设好${ActionRouter.dayWord(d.dayOffset)} ${hhmm} 的提醒：${d.label}。`;
    }
    if (d.kind === 'createTravel') {
      return `已设好出行提醒：${d.label}，出发前一小时和出发时各提醒一次。`;
    }
    if (d.kind === 'toggleFlashlight') {
      return d.label === 'off' ? '已关掉手电筒。' : '已打开手电筒。';
    }
    if (d.kind === 'createTodo') {
      const title = d.label.length > 0 ? d.label : '待办';
      return d.hour >= 0 ? `已记下待办：${title}，${ActionRouter.dayWord(d.dayOffset)} ${hhmm} 提醒你。` :
        `已记下待办：${title}。`;
    }
    if (d.kind === 'writeClipboard') {
      return '已写入剪贴板。';
    }
    if (d.kind === 'deviceInfo') {
      return '已读取这台设备的信息。';
    }
    return '';
  }

  static chip(kind: string): string {
    if (kind === 'savePhoto') {
      return '系统相册';
    }
    if (kind === 'setAlarm') {
      return '系统闹钟';
    }
    if (kind === 'createCalendar') {
      return '系统提醒';
    }
    if (kind === 'createTravel') {
      return '出行提醒';
    }
    if (kind === 'toggleFlashlight') {
      return '手电筒';
    }
    if (kind === 'createTodo') {
      return '待办';
    }
    if (kind === 'writeClipboard') {
      return '剪贴板';
    }
    if (kind === 'deviceInfo') {
      return '设备信息';
    }
    return '';
  }

  /** 做完之后的执行凭证,和安卓同一个格式。 */
  static receipt(d: ActionDecision, summary: string): string {
    let undo = '无需撤销';
    if (d.kind === 'setAlarm' || d.kind === 'createCalendar' || d.kind === 'createTravel') {
      undo = '响起时可关闭';
    } else if (d.kind === 'toggleFlashlight') {
      undo = '可用相反指令恢复';
    } else if (d.kind === 'createTodo') {
      undo = '在通知栏划掉即可';
    } else if (d.kind === 'writeClipboard') {
      undo = '可再次写入剪贴板';
    } else if (d.kind === 'deviceInfo') {
      undo = '只读操作，无需撤销';
    }
    return `${summary}\n\n执行凭证\n- 路径：${ActionRouter.chip(d.kind)}\n- 核对：系统已确认完成\n- 撤销：${undo}`;
  }

  static failureReceipt(d: ActionDecision, nextStep: string): string {
    return `没有完成这项操作。\n\n执行凭证\n- 路径：${ActionRouter.chip(d.kind)}\n- 核对：系统未确认完成\n- 下一步：${nextStep}`;
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
      'add to calendar', 'create calendar event', '创建日程', '记到日历', '安排日程'
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
      '提醒我', '记得提醒', '到时候提醒', '别忘了', '别忘记', '帮我记一下', '帮我记下',
      'add a todo', 'add todo', 'remind me to', 'remember to'
    ]);
  }

  static clipboardWriteText(raw: string): string {
    const zh = /^把([\s\S]{1,4000})复制到剪贴板[。.]?$/.exec(raw);
    if (zh) {
      return zh[1].trim();
    }
    const zh2 = /^复制到剪贴板[：:]?\s*([\s\S]{1,4000})$/.exec(raw);
    if (zh2) {
      return zh2[1].trim();
    }
    const en = /^copy\s+([\s\S]{1,4000})\s+to\s+(?:the\s+)?clipboard[.!]?$/i.exec(raw);
    return en ? en[1].trim() : '';
  }

  static isDeviceInfo(lower: string): boolean {
    return ActionRouter.hasAny(lower, [
      '设备信息', '手机信息', '这台手机是什么型号', '这台设备是什么型号',
      'device info', 'phone model', 'device model'
    ]);
  }

  static isTomorrow(lower: string): boolean {
    return lower.indexOf('明早') >= 0 || lower.indexOf('明天') >= 0 ||
      lower.indexOf('tomorrow') >= 0 || lower.indexOf('tmrw') >= 0;
  }

  /** 从今天起的第几天:后天、N 天后、M 月 D 日(过了算明年)、(下)周几。 */
  static dayOffset(lower: string, today: Date = new Date()): number {
    if (lower.indexOf('后天') >= 0 || lower.indexOf('day after tomorrow') >= 0) {
      return 2;
    }
    if (ActionRouter.isTomorrow(lower)) {
      return 1;
    }
    const later = /(\d{1,3})\s*天后/.exec(lower);
    if (later) {
      return Math.min(366, Math.max(0, Number(later[1])));
    }
    const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const md = /(\d{1,2})月(\d{1,2})[日号]?/.exec(lower);
    if (md) {
      const month = Number(md[1]);
      const day = Number(md[2]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        let target = new Date(base.getFullYear(), month - 1, day);
        if (target.getMonth() === month - 1) {
          if (target.getTime() < base.getTime()) {
            target = new Date(base.getFullYear() + 1, month - 1, day);
          }
          return Math.min(366, Math.max(0, Math.round((target.getTime() - base.getTime()) / 86400000)));
        }
      }
    }
    const week = /(下)?(?:周|星期)([一二三四五六日天])/.exec(lower);
    if (week) {
      const names = '一二三四五六';
      const idx = names.indexOf(week[2]);
      const target = idx >= 0 ? idx + 1 : 7;
      const todayValue = ((today.getDay() + 6) % 7) + 1;
      const delta = ((target - todayValue) % 7 + 7) % 7;
      return Math.min(366, delta + (week[1] ? 7 : 0));
    }
    return 0;
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

  static dayWord(offset: number): string {
    if (offset <= 0) {
      return '今天';
    }
    if (offset === 1) {
      return '明天';
    }
    if (offset === 2) {
      return '后天';
    }
    return `${offset} 天后`;
  }

  static two(n: number): string {
    if (n < 0) {
      return '--';
    }
    return n < 10 ? `0${n}` : `${n}`;
  }

  private static make(path: string, kind: string): ActionDecision {
    const d = new ActionDecision();
    d.path = path;
    d.kind = kind;
    return d;
  }

  private static withTime(d: ActionDecision, raw: string, lower: string, today: Date): void {
    const time = ActionRouter.parseTime(raw, lower);
    if (time.length === 2) {
      d.hour = time[0];
      d.minute = time[1];
    }
    d.tomorrow = ActionRouter.isTomorrow(lower);
    d.dayOffset = ActionRouter.dayOffset(lower, today);
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

  private static tidy(text: string): string {
    return text.replace(/^[\s，,。.：:]+|[\s，,。.：:]+$/g, '');
  }

  private static stripDates(text: string): string {
    return text
      .replace(/今天|今晚|今早|明早|明天|后天|tomorrow|tmrw|day after tomorrow/gi, '')
      .replace(/\d{1,3}\s*天后|\d{1,2}月\d{1,2}[日号]?|(?:下)?(?:周|星期)[一二三四五六日天]/g, '')
      .replace(/上午|中午|下午|晚上|早上|凌晨/g, '')
      .replace(/\d{1,2}[:：]\d{2}/g, '')
      .replace(/\d{1,2}\s*点\s*\d{0,2}\s*分?/g, '');
  }

  private static alarmLabel(raw: string): string {
    const out = ActionRouter.tidy(raw.replace(/明早|明天|tomorrow|tmrw|闹钟|set alarm|alarm for|alarm at/gi, '')
      .replace(/\d{1,2}[:：]\d{2}/g, '').replace(/\d{1,2}\s*点\s*\d{0,2}\s*分?/g, ''));
    return out.length > 0 ? out : '闹钟';
  }

  private static calendarTitle(raw: string): string {
    const out = ActionRouter.tidy(ActionRouter.stripDates(raw.replace(
      /加到日历|写入日历|添加到日历|加进日历|记到日历|安排日程|add to calendar|create calendar event|创建日程/gi, ''))
      .replace(/^[\s，,。.：:]*(?:要|的|在|于)\s*/, ''));
    return out.length > 0 ? out : '日程';
  }

  private static todoTitle(raw: string): string {
    return ActionRouter.tidy(ActionRouter.stripDates(raw.replace(
      /记个待办|记一条待办|添加待办|写个待办|提醒我|记得提醒|到时候提醒|别忘了|别忘记|帮我记一下|帮我记下|add a todo|add todo|remind me to|remember to/gi, ''))
      .replace(/^[\s，,。.：:]*(?:要|的|在|于)\s*/, ''));
  }

  private static extractLocation(raw: string): string {
    const hit = new RegExp(`(?:在|去|到)\\s*([${CJK_WORD}0-9·_-]{2,24}?)(?:开会|复诊|办事|见面|[，,。\\s])`).exec(raw);
    return hit ? hit[1].trim() : '';
  }
}
