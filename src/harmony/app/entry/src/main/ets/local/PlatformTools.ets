import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';
import { calendarManager } from '@kit.CalendarKit';
import { contact } from '@kit.ContactsKit';
import { intl } from '@kit.LocalizationKit';
import { reminderAgentManager } from '@kit.BackgroundTasksKit';
import { camera, cameraPicker } from '@kit.CameraKit';
import { fileIo, fileUri } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { SensitiveToolGate } from './SensitiveToolGate';
import { toolArg, WRITE_GRANT_MARK } from './LocalProtocol';
import { extraToolFields } from './ExtraToolSchemas';
import { DocumentScanFlow } from './DocumentScanFlow';

type NativeArgs = Record<string, Object>;
class TimeRange { start: number = 0; end: number = 0; }
class BusyInterval { start: number = 0; end: number = 0; }
class EventTarget { calendar: calendarManager.Calendar; event: calendarManager.Event;
  constructor(calendar: calendarManager.Calendar, event: calendarManager.Event) { this.calendar = calendar; this.event = event; } }

function has(args: NativeArgs, key: string): boolean { return Object.keys(args).indexOf(key) >= 0; }
function value(args: NativeArgs, key: string): string { return `${args[key] ?? ''}`; }
function textValue(args: NativeArgs, key: string, maximum: number = 500): string {
  const raw = value(args, key);
  if (raw.length > maximum || raw.indexOf('\u0000') >= 0) throw new Error(`${key}长度或内容无效`);
  return raw;
}
function numeric(raw: string, minimum: number, maximum: number): number {
  const number = Number(raw);
  if (!raw || !Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error('编号或数量无效');
  return number;
}
function pageNumber(args: NativeArgs, key: string, fallback: number, maximum: number): number {
  return has(args, key) ? numeric(value(args, key), key === 'offset' ? 0 : 1, maximum) : fallback;
}
function timestamp(raw: string): number {
  const relative = raw.match(/^([+-]?\d+)([dhm])$/);
  let number: number;
  if (relative) {
    const factor = relative[2] === 'd' ? 86400000 : relative[2] === 'h' ? 3600000 : 60000;
    number = Date.now() + Number(relative[1]) * factor;
  } else {
    const date = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (date) {
      const check = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
      if (check.getFullYear() !== Number(date[1]) || check.getMonth() !== Number(date[2]) - 1 || check.getDate() !== Number(date[3])) throw new Error('日期无效');
    }
    if (!/^\d{13}$/.test(raw) && !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(raw)) throw new Error('时间格式无效');
    number = /^\d{13}$/.test(raw) ? Number(raw) : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw + 'T00:00:00' : raw);
  }
  if (!Number.isSafeInteger(number) || Math.abs(number) > 8640000000000000) throw new Error('时间需为ISO格式、13位毫秒时间戳或相对值，例如+2h');
  return number;
}
function dateRange(args: NativeArgs): TimeRange {
  const range = new TimeRange();
  const now = new Date();
  if (value(args, 'today') === 'true') {
    range.start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    range.end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  } else if (has(args, 'days')) {
    const days = numeric(value(args, 'days'), 1, 366);
    range.start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime();
    range.end = now.getTime();
  } else {
    range.start = has(args, 'start') ? timestamp(value(args, 'start')) : now.getTime() - 86400000;
    range.end = has(args, 'end') ? timestamp(value(args, 'end')) : now.getTime();
  }
  if (range.end <= range.start || range.end - range.start > 366 * 86400000) throw new Error('查询区间需为1年以内，结束时间晚于开始时间');
  return range;
}
function arrayValue(args: NativeArgs, key: string): Object[] {
  const input = typeof args[key] === 'string' ? JSON.parse(value(args, key)) as Object : args[key];
  if (!Array.isArray(input) || input.length > 100) throw new Error(`${key}需为最多100项的JSON数组`);
  return input as Object[];
}
function labeledValue(item: Object, field: string): NativeArgs {
  if (typeof item === 'string') return { 'value': item, 'label': '' };
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${field}数组项无效`);
  const entry = item as NativeArgs;
  if (typeof entry['value'] !== 'string') throw new Error(`${field}数组项需要value字符串`);
  return entry;
}
function unsupported(operation: string, reason: string): string {
  return JSON.stringify({ 'status': 'unsupported', 'operation': operation, 'reason': reason });
}
function active(isCurrent: () => boolean): void {
  if (!isCurrent() || AppStorage.get<boolean>('platformForeground') !== true) throw new Error('任务已取消或应用已退到后台');
}
async function permission(context: common.Context, permissions: Permissions[], isCurrent: () => boolean): Promise<void> {
  const result = await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(context, permissions);
  active(isCurrent);
  if (result.authResults.length !== permissions.length || result.authResults.some((code: number) => code !== 0)) throw new Error('系统权限未授予');
}
function granted(context: common.Context, name: Permissions): boolean {
  return abilityAccessCtrl.createAtManager().checkAccessTokenSync(context.applicationInfo.accessTokenId, name) === 0;
}
function calendarLabel(calendar: calendarManager.Calendar): string {
  const account = calendar.getAccount();
  return account.displayName || account.name;
}
function contactJSON(entry: contact.Contact, full: boolean): NativeArgs {
  const result: NativeArgs = {
    'key': entry.key ?? '', 'name': entry.name?.fullName ?? '',
    'first_name': entry.name?.givenName ?? '', 'last_name': entry.name?.familyName ?? '',
    'organization': entry.organization?.name ?? '',
    'phones': (entry.phoneNumbers ?? []).map((phone: contact.PhoneNumber) => phone.phoneNumber),
    'phone_details': (entry.phoneNumbers ?? []).map((phone: contact.PhoneNumber): NativeArgs => ({ 'value': phone.phoneNumber, 'label': phone.labelName ?? '' })),
    'emails': (entry.emails ?? []).map((email: contact.Email): NativeArgs => ({ 'value': email.email, 'label': email.labelName ?? '' }))
  };
  if (entry.id !== undefined) result['id'] = entry.id;
  if (full) {
    result['middle_name'] = entry.name?.middleName ?? '';
    result['nickname'] = entry.nickName?.nickName ?? '';
    result['job_title'] = entry.organization?.title ?? '';
    result['groups'] = entry.groups ?? [];
    result['addresses'] = entry.postalAddresses ?? [];
    result['websites'] = (entry.websites ?? []).map((website: contact.Website) => website.website);
    result['events'] = entry.events ?? [];
    result['notes_returned'] = !!entry.note;
    if (entry.note) result['note'] = entry.note.noteContent;
    result['image_available'] = !!entry.portrait;
  }
  return result;
}

export class PlatformTools {
  static readonly NAMES: string[] = [
    'calendar_list', 'calendar_get', 'calendar_calendars', 'calendar_status', 'calendar_freebusy',
    'calendar_create', 'calendar_update', 'calendar_delete', 'calendar_open_editor',
    'calendar_reminders', 'calendar_reminder_create', 'calendar_reminder_update', 'calendar_reminder_delete', 'calendar_reminder_complete',
    'contacts_list', 'contacts_search', 'contacts_get', 'contacts_groups', 'contacts_status',
    'contacts_create', 'contacts_update', 'contacts_delete', 'camera_capture', 'document_scan'
  ];
  static async run(context: common.Context, name: string, raw: string, owner: string, unattended: boolean,
    isCurrent: () => boolean = () => true): Promise<string> {
    if (!isCurrent()) return '任务已取消';
    if (unattended || !owner || AppStorage.get<boolean>('platformForeground') !== true) return '此工具涉及个人资料或交互界面，请在本机前台对话中执行。';
    const ui = context as common.UIAbilityContext;
    if (typeof ui.startAbility !== 'function') return '当前没有前台界面，无法使用此工具。';
    if (PlatformTools.NAMES.indexOf(name) < 0) throw new Error('未知手机工具');
    const decoded = JSON.parse(raw) as Object;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('工具参数需为JSON对象');
    const args = decoded as NativeArgs;
    if (name === 'calendar_reminder_complete') return unsupported(name, '公开提醒代理API提供发布、更新和取消，未提供系统待办的完成/撤销完成状态。');
    if (name.startsWith('calendar_reminder') && (has(args, 'priority') || has(args, 'list'))) return unsupported(name, '系统提醒代理未开放待办清单与优先级字段，此入口仅管理本App发布的提醒。');
    if (name.startsWith('calendar_') && (value(args, 'span') === 'this' || value(args, 'span') === 'future' || has(args, 'occurrence_date'))) return unsupported(name, '公开CalendarKit未提供单个重复实例或未来实例范围的程序化修改，请使用系统编辑页处理。');
    if (has(args, 'target_calendar_id')) return unsupported(name, 'CalendarKit未提供保留原ID的跨日历移动接口。');
    const accepted = extraToolFields(name);
    const unknown = Object.keys(args).find((key: string) => accepted.indexOf(key) < 0);
    if (unknown) return unsupported(name, '此入口未开放参数' + unknown + '，本次参数未提交。');
    // Validate per-run data before opening permission dialogs or consuming an approval.
    if (name === 'contacts_create' || name === 'contacts_update') {
      const validation: contact.Contact = {};
      const fields = PlatformTools.contactValues(validation, args);
      if (name === 'contacts_create' && !validation.name?.fullName?.trim() && !validation.organization?.name?.trim()) throw new Error('联系人需要姓名或组织名称');
      if (name === 'contacts_update' && !fields.length) throw new Error('请提供要更新的字段');
    }
    if (name === 'calendar_create') {
      const validation: calendarManager.Event = { type: calendarManager.EventType.NORMAL, title: '',
        startTime: timestamp(value(args, 'start')), endTime: timestamp(value(args, 'end')) };
      PlatformTools.applyEvent(validation, args);
      if (!validation.title?.trim()) throw new Error('日程标题不能为空');
    }
    if (name === 'calendar_update' && !['title', 'start', 'end', 'notes', 'location', 'time_zone', 'all_day', 'alarm'].some((key: string) => has(args, key))) throw new Error('请提供要更新的日程字段');
    if (name === 'calendar_reminder_create' && (!value(args, 'title').trim() || timestamp(value(args, 'due')) <= Date.now())) throw new Error('提醒需要标题和未来的提醒时间');
    if (name === 'calendar_reminder_update' && !['title', 'due', 'notes'].some((key: string) => has(args, key))) throw new Error('请提供要更新的提醒字段');
    const write = /_(create|update|delete)$/.test(name);
    if (write && !SensitiveToolGate.consumeWriteGrant(owner)) return WRITE_GRANT_MARK + name;
    if (name.startsWith('contacts_')) return PlatformTools.contacts(context, name, args, isCurrent);
    if (name.startsWith('calendar_reminder')) return PlatformTools.reminders(context, name, args, isCurrent);
    if (name.startsWith('calendar_')) return PlatformTools.calendar(context, name, args, isCurrent);
    if (name === 'camera_capture' && value(args, 'facing') && value(args, 'facing') !== 'front' && value(args, 'facing') !== 'back') return unsupported(name, '系统相机选择器提供front/back位置，内外屏镜头由系统相机界面选择。');
    await permission(context, ['ohos.permission.CAMERA'], isCurrent);
    if (name === 'document_scan') return DocumentScanFlow.open(ui, isCurrent);
    return PlatformTools.capture(ui, toolArg(raw, 'facing'), isCurrent);
  }

  private static async calendars(context: common.Context, args: NativeArgs, isCurrent: () => boolean,
    defaultOnly: boolean = false): Promise<calendarManager.Calendar[]> {
    const manager = calendarManager.getCalendarManager(context);
    if (defaultOnly && !has(args, 'calendar_id') && !has(args, 'calendar')) {
      const calendar = await manager.getCalendar(); active(isCurrent); return [calendar];
    }
    const all = await manager.getAllCalendars(); active(isCurrent);
    if (has(args, 'calendar_id')) {
      const id = numeric(value(args, 'calendar_id'), 1, Number.MAX_SAFE_INTEGER);
      const matches = all.filter((calendar: calendarManager.Calendar) => calendar.id === id);
      if (matches.length !== 1) throw new Error('找不到已授权的日历编号');
      if (has(args, 'calendar') && calendarLabel(matches[0]).toLowerCase() !== value(args, 'calendar').trim().toLowerCase()) throw new Error('日历编号与名称不一致');
      return matches;
    }
    if (has(args, 'calendar')) {
      const label = value(args, 'calendar').trim().toLowerCase();
      const matches = all.filter((calendar: calendarManager.Calendar) => calendarLabel(calendar).toLowerCase() === label);
      if (matches.length !== 1) throw new Error('日历名称不存在或不唯一，请使用calendar_id');
      return matches;
    }
    return all;
  }
  private static async eventTarget(calendars: calendarManager.Calendar[], args: NativeArgs,
    isCurrent: () => boolean): Promise<EventTarget> {
    const id = numeric(value(args, 'id'), 1, Number.MAX_SAFE_INTEGER);
    const matches: EventTarget[] = [];
    for (const calendar of calendars) {
      const events = await calendar.getEvents(calendarManager.EventFilter.filterById([id]),
        ['id', 'type', 'title', 'startTime', 'endTime', 'location', 'description', 'timeZone',
          'isAllDay', 'attendee', 'reminderTime', 'recurrenceRule', 'identifier', 'isLunar']);
      active(isCurrent);
      events.forEach((event: calendarManager.Event) => matches.push(new EventTarget(calendar, event)));
    }
    if (matches.length !== 1) throw new Error('日程不存在或编号存在歧义，请同时提供calendar_id');
    return matches[0];
  }
  private static applyEvent(event: calendarManager.Event, args: NativeArgs): void {
    if (has(args, 'title')) {
      const title = textValue(args, 'title', 500).trim();
      if (!title) throw new Error('日程标题不能为空');
      event.title = title;
    }
    if (has(args, 'start')) event.startTime = timestamp(value(args, 'start'));
    if (has(args, 'end')) event.endTime = timestamp(value(args, 'end'));
    if (event.endTime <= event.startTime) throw new Error('结束时间应晚于开始时间');
    if (has(args, 'notes')) event.description = textValue(args, 'notes', 5000);
    if (has(args, 'location')) {
      const location: calendarManager.Location = event.location ?? {};
      location.location = textValue(args, 'location', 5000);
      event.location = location;
    }
    if (has(args, 'time_zone')) {
      const zone = textValue(args, 'time_zone', 100);
      if (zone) {
        try { new intl.DateTimeFormat('en', { timeZone: zone }).format(new Date()); }
        catch (_error) { throw new Error('time_zone需为有效IANA时区，例如Asia/Shanghai'); }
      }
      event.timeZone = zone;
    }
    if (has(args, 'all_day')) {
      if (value(args, 'all_day') !== 'true' && value(args, 'all_day') !== 'false') throw new Error('all_day需为true或false');
      event.isAllDay = value(args, 'all_day') === 'true';
    }
    if (has(args, 'alarm')) {
      const minutes = numeric(value(args, 'alarm'), 0, 525600);
      event.reminderTime = minutes === 0 ? [] : [minutes];
    }
  }
  private static async calendar(context: common.Context, name: string, args: NativeArgs,
    isCurrent: () => boolean): Promise<string> {
    if (name === 'calendar_status') return JSON.stringify({ 'read': granted(context, 'ohos.permission.READ_CALENDAR'),
      'write': granted(context, 'ohos.permission.WRITE_CALENDAR'), 'scope': 'system_authorized_calendars_and_events',
      'unsupported': ['programmatic_single_or_future_occurrence_edit', 'atomic_cross_calendar_move'] });
    const write = /_(create|update|delete)$/.test(name);
    await permission(context, write ? ['ohos.permission.READ_CALENDAR', 'ohos.permission.WRITE_CALENDAR'] :
      ['ohos.permission.READ_CALENDAR'], isCurrent);
    const calendars = await PlatformTools.calendars(context, args, isCurrent, name === 'calendar_create');
    if (name === 'calendar_calendars') return JSON.stringify(calendars.map((calendar: calendarManager.Calendar): NativeArgs => {
      const account = calendar.getAccount();
      return { 'id': calendar.id, 'name': account.name, 'display_name': account.displayName ?? '', 'type': account.type };
    }));
    if (name === 'calendar_list' || name === 'calendar_freebusy') {
      const range = dateRange(args);
      const records: NativeArgs[] = [];
      for (const calendar of calendars) {
        if (typeof calendar.queryEventInstances !== 'function') return unsupported(name, '当前系统未开放日历实例查询。');
        const events = await calendar.queryEventInstances(range.start, range.end);
        active(isCurrent);
        events.forEach((event: calendarManager.Event) => {
          const record = JSON.parse(JSON.stringify(event)) as NativeArgs;
          record['calendar_id'] = calendar.id;
          records.push(record);
        });
      }
      records.sort((a: NativeArgs, b: NativeArgs) => Number(a['instanceStartTime'] ?? a['startTime']) - Number(b['instanceStartTime'] ?? b['startTime']));
      if (name === 'calendar_list') {
        const offset = pageNumber(args, 'offset', 0, Number.MAX_SAFE_INTEGER);
        const limit = pageNumber(args, 'limit', 50, 500);
        return JSON.stringify(records.slice(offset, offset + limit));
      }
      const busy: BusyInterval[] = [];
      for (const event of records) {
        const start = Math.max(range.start, Number(event['instanceStartTime'] ?? event['startTime']));
        const end = Math.min(range.end, Number(event['instanceEndTime'] ?? event['endTime']));
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        const last = busy.length ? busy[busy.length - 1] : undefined;
        if (last && start <= last.end) last.end = Math.max(last.end, end);
        else { const interval = new BusyInterval(); interval.start = start; interval.end = end; busy.push(interval); }
      }
      const free: BusyInterval[] = [];
      let cursor = range.start;
      for (const interval of busy) {
        if (interval.start > cursor) { const gap = new BusyInterval(); gap.start = cursor; gap.end = interval.start; free.push(gap); }
        cursor = interval.end;
      }
      if (cursor < range.end) { const gap = new BusyInterval(); gap.start = cursor; gap.end = range.end; free.push(gap); }
      return JSON.stringify({ 'start': range.start, 'end': range.end, 'busy': busy, 'free': free,
        'basis': 'visible_event_instances', 'availability_field': 'not_exposed_by_CalendarKit' });
    }
    if (name === 'calendar_create') {
      const event: calendarManager.Event = { type: calendarManager.EventType.NORMAL,
        title: '', startTime: timestamp(value(args, 'start')), endTime: timestamp(value(args, 'end')) };
      PlatformTools.applyEvent(event, args);
      if (!event.title) throw new Error('日程标题不能为空');
      active(isCurrent);
      const id = await calendars[0].addEvent(event);
      return JSON.stringify({ 'id': id, 'calendar_id': calendars[0].id, 'status': 'created' });
    }
    const target = await PlatformTools.eventTarget(calendars, args, isCurrent);
    if (name === 'calendar_get') {
      const record = JSON.parse(JSON.stringify(target.event)) as NativeArgs;
      record['calendar_id'] = target.calendar.id;
      return JSON.stringify(record);
    }
    if (name === 'calendar_open_editor') { active(isCurrent); await target.calendar.openEventEditPage(target.event.id as number); return JSON.stringify({ 'status': 'editor_opened', 'id': target.event.id ?? 0 }); }
    if (target.event.recurrenceRule && value(args, 'span') !== 'all') return unsupported(name, '此日程为重复系列，请明确span=all修改整个系列，或通过系统编辑页处理单个实例。');
    active(isCurrent);
    if (name === 'calendar_delete') {
      await target.calendar.deleteEvent(target.event.id as number);
      return JSON.stringify({ 'id': target.event.id ?? 0, 'calendar_id': target.calendar.id, 'status': 'deleted' });
    }
    PlatformTools.applyEvent(target.event, args);
    active(isCurrent);
    await target.calendar.updateEvent(target.event);
    return JSON.stringify({ 'id': target.event.id ?? 0, 'calendar_id': target.calendar.id, 'status': 'updated' });
  }

  private static contactValues(entry: contact.Contact, args: NativeArgs): contact.Attribute[] {
    const attributes: contact.Attribute[] = [];
    if (value(args, 'name').trim() || has(args, 'first_name') || has(args, 'last_name') || has(args, 'middle_name')) {
      const person: contact.Name = entry.name ?? { fullName: '' };
      if (has(args, 'first_name')) person.givenName = textValue(args, 'first_name', 200);
      if (has(args, 'last_name')) person.familyName = textValue(args, 'last_name', 200);
      if (has(args, 'middle_name')) person.middleName = textValue(args, 'middle_name', 200);
      if (value(args, 'name').trim()) person.fullName = textValue(args, 'name', 500).trim();
      else if (has(args, 'first_name') || has(args, 'last_name') || has(args, 'middle_name')) person.fullName = [person.familyName ?? '', person.givenName ?? '', person.middleName ?? ''].filter((part: string) => !!part).join(' ');
      if (!person.fullName) person.fullName = '';
      entry.name = person;
      attributes.push(contact.Attribute.ATTR_NAME);
    }
    if (has(args, 'organization') || has(args, 'job_title')) {
      const organization: contact.Organization = entry.organization ?? { name: '' };
      if (!organization.name) organization.name = '';
      if (has(args, 'organization')) organization.name = textValue(args, 'organization', 500);
      if (has(args, 'job_title')) organization.title = textValue(args, 'job_title', 500);
      entry.organization = organization;
      attributes.push(contact.Attribute.ATTR_ORGANIZATION);
    }
    if (has(args, 'nickname')) { const nickname: contact.NickName = { nickName: textValue(args, 'nickname', 200) }; entry.nickName = nickname; attributes.push(contact.Attribute.ATTR_NICKNAME); }
    if (has(args, 'note')) { const note: contact.Note = { noteContent: textValue(args, 'note', 16000) }; entry.note = note; attributes.push(contact.Attribute.ATTR_NOTE); }
    if (has(args, 'phones')) {
      entry.phoneNumbers = arrayValue(args, 'phones').map((item: Object) => {
        const input = labeledValue(item, 'phones');
        const number: contact.PhoneNumber = { phoneNumber: '' };
        number.phoneNumber = textValue(input, 'value', 200).trim();
        if (!number.phoneNumber) throw new Error('电话号码不能为空');
        number.labelId = value(input, 'label') ? contact.PhoneNumber.CUSTOM_LABEL : contact.PhoneNumber.NUM_MOBILE;
        if (value(input, 'label')) number.labelName = textValue(input, 'label', 100);
        return number;
      });
      attributes.push(contact.Attribute.ATTR_PHONE);
    } else if (value(args, 'phone').trim()) {
      const number: contact.PhoneNumber = entry.phoneNumbers?.[0] ?? { phoneNumber: '', labelId: contact.PhoneNumber.NUM_MOBILE };
      number.phoneNumber = textValue(args, 'phone', 200).trim();
      if (number.labelId === undefined) number.labelId = contact.PhoneNumber.NUM_MOBILE;
      entry.phoneNumbers = [number].concat((entry.phoneNumbers ?? []).slice(1));
      attributes.push(contact.Attribute.ATTR_PHONE);
    }
    if (has(args, 'emails')) {
      entry.emails = arrayValue(args, 'emails').map((item: Object) => {
        const input = labeledValue(item, 'emails');
        const email: contact.Email = { email: '' }; email.email = textValue(input, 'value', 320).trim();
        if (!/^[^\s@]+@[^\s@]+$/.test(email.email)) throw new Error('邮箱格式无效');
        email.labelId = value(input, 'label') ? contact.Email.CUSTOM_LABEL : contact.Email.EMAIL_OTHER;
        if (value(input, 'label')) email.labelName = textValue(input, 'label', 100);
        return email;
      });
      attributes.push(contact.Attribute.ATTR_EMAIL);
    }
    if (has(args, 'addresses')) {
      entry.postalAddresses = arrayValue(args, 'addresses').map((item: Object) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('addresses需要结构化地址数组');
        const input = item as NativeArgs;
        const address: contact.PostalAddress = { postalAddress: '' };
        address.street = textValue(input, 'street', 1000); address.city = textValue(input, 'city', 200);
        address.region = textValue(input, 'region', 200); address.country = textValue(input, 'country', 200);
        address.postcode = textValue(input, 'postal_code', 100);
        address.postalAddress = textValue(input, 'formatted', 4000) || [address.street, address.city, address.region, address.postcode, address.country].filter((part: string) => !!part).join(', ');
        if (!address.postalAddress) throw new Error('地址不能为空');
        address.labelId = contact.PostalAddress.CUSTOM_LABEL; address.labelName = textValue(input, 'label', 100);
        return address;
      });
      attributes.push(contact.Attribute.ATTR_POSTAL_ADDRESS);
    }
    if (has(args, 'birthday')) {
      const birthday = textValue(args, 'birthday', 10);
      if (birthday && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) throw new Error('生日需为YYYY-MM-DD，空字符串表示清除');
      if (birthday) {
        const parsed = new Date(birthday + 'T00:00:00Z');
        if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().substring(0, 10) !== birthday) throw new Error('生日日期无效');
      }
      entry.events = (entry.events ?? []).filter((event: contact.Event) => event.labelId !== contact.Event.EVENT_BIRTHDAY);
      if (birthday) { const event: contact.Event = { labelId: contact.Event.EVENT_BIRTHDAY, eventDate: birthday }; entry.events.push(event); }
      attributes.push(contact.Attribute.ATTR_CONTACT_EVENT);
    }
    return attributes;
  }
  private static async contacts(context: common.Context, name: string, args: NativeArgs,
    isCurrent: () => boolean): Promise<string> {
    if (name === 'contacts_status') return JSON.stringify({ 'read': granted(context, 'ohos.permission.READ_CONTACTS'), 'write': granted(context, 'ohos.permission.WRITE_CONTACTS'), 'scope': 'system_authorized_contacts' });
    const write = /_(create|update|delete)$/.test(name);
    await permission(context, write ? ['ohos.permission.READ_CONTACTS', 'ohos.permission.WRITE_CONTACTS'] :
      ['ohos.permission.READ_CONTACTS'], isCurrent);
    if (name === 'contacts_groups') { const groups = await contact.queryGroups(context); active(isCurrent); return JSON.stringify(groups); }
    if (name === 'contacts_list' || name === 'contacts_search') {
      const query = value(args, 'query').trim().toLowerCase();
      if (name === 'contacts_search' && !query) throw new Error('请输入姓名、电话、邮箱或组织关键词');
      const group = value(args, 'group').trim().toLowerCase();
      const rows = await contact.queryContacts(context); active(isCurrent);
      const matches = rows.filter((entry: contact.Contact) => {
        const inGroup = !group || (entry.groups ?? []).some((item: contact.Group) => item.title.toLowerCase() === group || String(item.groupId) === group);
        const searchable = [entry.name?.fullName ?? '', entry.name?.givenName ?? '', entry.name?.familyName ?? '', entry.nickName?.nickName ?? '', entry.organization?.name ?? '',
          (entry.phoneNumbers ?? []).map((phone: contact.PhoneNumber) => phone.phoneNumber).join(' '),
          (entry.emails ?? []).map((email: contact.Email) => email.email).join(' ')].join(' ').toLowerCase();
        return inGroup && (!query || searchable.includes(query) || searchable.replace(/\s+/g, '').includes(query.replace(/\s+/g, '')));
      });
      const offset = pageNumber(args, 'offset', 0, Number.MAX_SAFE_INTEGER);
      const limit = pageNumber(args, 'limit', name === 'contacts_search' ? 30 : 50, 500);
      return JSON.stringify(matches.slice(offset, offset + limit).map((entry: contact.Contact) => contactJSON(entry, false)));
    }
    if (name === 'contacts_create') {
      const entry: contact.Contact = {}; PlatformTools.contactValues(entry, args);
      if (!entry.name?.fullName?.trim() && !entry.organization?.name?.trim()) throw new Error('联系人需要姓名或组织名称');
      active(isCurrent);
      const id = await contact.addContact(context, entry);
      return JSON.stringify({ 'id': id, 'status': 'created' });
    }
    const key = textValue(args, 'key', 500).trim();
    if (!key) throw new Error('需要查询结果中的联系人key');
    const entry = await contact.queryContact(context, key); active(isCurrent);
    if (!entry.key || entry.key !== key) throw new Error('联系人不存在或已改变，请重新查询');
    if (name === 'contacts_get') return JSON.stringify(contactJSON(entry, true));
    if (name === 'contacts_delete') { await contact.deleteContact(context, key); return JSON.stringify({ 'key': key, 'status': 'deleted' }); }
    const attributes = PlatformTools.contactValues(entry, args);
    if (!attributes.length) throw new Error('请提供要更新的字段');
    active(isCurrent);
    await contact.updateContact(context, entry, { attributes: attributes });
    return JSON.stringify({ 'key': key, 'status': 'updated' });
  }

  private static async reminders(context: common.Context, name: string, args: NativeArgs,
    isCurrent: () => boolean): Promise<string> {
    await permission(context, ['ohos.permission.PUBLISH_AGENT_REMINDER'], isCurrent);
    if (name === 'calendar_reminders') {
      const records = await reminderAgentManager.getAllValidReminders(); active(isCurrent);
      return JSON.stringify({ 'scope': 'app_owned_reminder_agents', 'items': records.map((record: reminderAgentManager.ReminderInfo): NativeArgs => {
        const request = record.reminderReq as reminderAgentManager.ReminderRequestCalendar;
        const output: NativeArgs = { 'id': record.reminderId, 'type': request.reminderType, 'title': request.title ?? '', 'notes': request.content ?? '' };
        if (request.dateTime) output['due'] = request.dateTime;
        return output;
      }) });
    }
    let request: reminderAgentManager.ReminderRequestCalendar;
    let id = -1;
    if (name === 'calendar_reminder_create') {
      const due = new Date(timestamp(value(args, 'due')));
      if (due.getTime() <= Date.now()) throw new Error('系统提醒代理需要未来的提醒时间');
      request = { reminderType: reminderAgentManager.ReminderType.REMINDER_TYPE_CALENDAR,
        dateTime: { year: due.getFullYear(), month: due.getMonth() + 1, day: due.getDate(), hour: due.getHours(), minute: due.getMinutes(), second: due.getSeconds() },
        title: textValue(args, 'title', 500), content: textValue(args, 'notes', 16000) };
      if (!request.title?.trim()) throw new Error('提醒标题不能为空');
    } else {
      id = numeric(value(args, 'id'), 0, Number.MAX_SAFE_INTEGER);
      const records = await reminderAgentManager.getAllValidReminders(); active(isCurrent);
      const existing = records.find((record: reminderAgentManager.ReminderInfo) => record.reminderId === id);
      if (!existing) throw new Error('找不到本App发布的提醒编号');
      if (name === 'calendar_reminder_delete') { active(isCurrent); await reminderAgentManager.cancelReminder(id); return JSON.stringify({ 'id': id, 'status': 'deleted', 'scope': 'app_owned_reminder_agents' }); }
      if (existing.reminderReq.reminderType !== reminderAgentManager.ReminderType.REMINDER_TYPE_CALENDAR) return unsupported(name, '此编号属于闹钟或计时器，请使用相应的手机工具处理。');
      request = existing.reminderReq as reminderAgentManager.ReminderRequestCalendar;
      if (has(args, 'title')) { request.title = textValue(args, 'title', 500); if (!request.title.trim()) throw new Error('提醒标题不能为空'); }
      if (has(args, 'notes')) request.content = textValue(args, 'notes', 16000);
      if (has(args, 'due')) {
        const due = new Date(timestamp(value(args, 'due')));
        if (due.getTime() <= Date.now()) throw new Error('系统提醒代理需要未来的提醒时间');
        request.dateTime = { year: due.getFullYear(), month: due.getMonth() + 1, day: due.getDate(), hour: due.getHours(), minute: due.getMinutes(), second: due.getSeconds() };
      }
    }
    active(isCurrent);
    if (name === 'calendar_reminder_create') id = await reminderAgentManager.publishReminder(request);
    else {
      if (typeof reminderAgentManager.updateReminder !== 'function') return unsupported(name, '当前系统未开放原子更新提醒接口。');
      await reminderAgentManager.updateReminder(id, request);
    }
    return JSON.stringify({ 'id': id, 'status': name === 'calendar_reminder_create' ? 'created' : 'updated', 'scope': 'app_owned_reminder_agents' });
  }

  private static async capture(context: common.UIAbilityContext, facing: string, isCurrent: () => boolean): Promise<string> {
    active(isCurrent);
    const dir = context.filesDir + '/workspace';
    if (!fileIo.accessSync(dir)) fileIo.mkdirSync(dir);
    const name = 'camera-' + util.generateRandomUUID(false) + '.jpg';
    const path = dir + '/' + name;
    const file = fileIo.openSync(path, fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC | fileIo.OpenMode.NOFOLLOW);
    fileIo.closeSync(file);
    let completed = false;
    try {
      const result = await cameraPicker.pick(context, [cameraPicker.PickerMediaType.PHOTO], {
        cameraPosition: facing === 'front' ? camera.CameraPosition.CAMERA_POSITION_FRONT : camera.CameraPosition.CAMERA_POSITION_BACK,
        saveUri: fileUri.getUriFromPath(path)
      });
      // The system camera result can arrive before the parent Ability returns to foreground.
      if (!isCurrent()) throw new Error('拍照任务已取消或已切换');
      if (result.resultCode !== 0 || fileIo.statSync(path).size === 0) throw new Error('拍照已取消或照片未保存');
      completed = true;
      return JSON.stringify({ 'path': name, 'status': 'captured', 'usage': '照片保存在本机沙箱，需要识图时再调用read_image' });
    } finally { if (!completed && fileIo.accessSync(path)) fileIo.unlinkSync(path); }
  }
}
