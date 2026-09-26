import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';
import { camera } from '@kit.CameraKit';
import { reminderAgentManager } from '@kit.BackgroundTasksKit';
import { notificationManager } from '@kit.NotificationKit';
import { batteryInfo, deviceInfo, pasteboard } from '@kit.BasicServicesKit';
import { ActionDecision, ActionRouter } from './ActionRouter';
import { LocalDateTime, nowLine } from './LocalProtocol';
import { taskStatus } from '../store/TaskStatus';

const PKG = 'com.leoyuan.leophoneagent.harmony';
const ABILITY = 'EntryAbility';

/**
 * Offline native actions for T7 / T2. Routing lives in ActionRouter;
 * this object only flips the torch, parks a todo, or publishes a reminder.
 *
 * ponytail: no GGUF, no second loop. Ceiling is OEM torch / reminder
 * permission quirks — throw falls through to the existing agent path.
 */
export class FastLocalActions {
  static async tryRoute(context: common.Context, text: string, imageCount: number): Promise<string> {
    const route = ActionRouter.decide(text, imageCount);
    if (route.path === 'clarify') {
      // 缺时间、缺车次这类:只追问缺的那一项,不让模型去猜。
      return ActionRouter.spoken(route);
    }
    if (route.path !== 'native' || route.kind === 'savePhoto') {
      // 存图到相册在鸿蒙上要走系统的保存确认框,交给模型那条路。
      return '';
    }
    let ok = false;
    let summary = ActionRouter.spoken(route);
    let nextStep = '再说一次试试';
    if (route.kind === 'toggleFlashlight') {
      ok = await FastLocalActions.setTorch(context, route.label !== 'off');
      nextStep = '在系统设置里给 LeoPhoneAgent 相机权限后再说一次';
    } else if (route.kind === 'createTodo') {
      ok = route.hour >= 0 ?
        await FastLocalActions.addReminderAt(context, FastLocalActions.at(route), route.label) :
        await FastLocalActions.addTodo(context, route.label);
      nextStep = route.hour >= 0 ? '在系统设置里允许「提醒」后再说一次' : '在系统设置里打开 LeoPhoneAgent 的通知后再说一次';
    } else if (route.kind === 'setAlarm') {
      // 闹钟只能定「下一次到点」;两天以后的改用那天的提醒。
      ok = route.dayOffset >= 2 ?
        await FastLocalActions.addReminderAt(context, FastLocalActions.at(route), route.label) :
        await FastLocalActions.addAlarm(context, route);
      nextStep = '在系统设置里允许「提醒」后再说一次';
    } else if (route.kind === 'createCalendar') {
      ok = await FastLocalActions.addReminderAt(context, FastLocalActions.at(route), route.label);
      nextStep = '在系统设置里允许「提醒」后再说一次';
    } else if (route.kind === 'createTravel') {
      ok = await FastLocalActions.addTravel(context, route);
      nextStep = '在系统设置里允许「提醒」后再说一次';
    } else if (route.kind === 'writeClipboard') {
      ok = await FastLocalActions.copyText(route.label);
    } else if (route.kind === 'deviceInfo') {
      summary = FastLocalActions.deviceSummary();
      ok = true;
    }
    return ok ? ActionRouter.receipt(route, summary) : ActionRouter.failureReceipt(route, nextStep);
  }

  /** 这个决定对应的本地时间点(今天起第 dayOffset 天的 hour:minute)。 */
  static at(route: ActionDecision): LocalDateTime {
    const day = new Date();
    day.setDate(day.getDate() + Math.max(0, route.dayOffset));
    const out = new LocalDateTime();
    out.year = day.getFullYear();
    out.month = day.getMonth() + 1;
    out.day = day.getDate();
    out.hour = Math.max(0, route.hour);
    out.minute = Math.max(0, route.minute);
    return out;
  }

  /** 出行:出发前一小时和出发时各提醒一次(已经过了前一小时就只提醒出发时)。 */
  static async addTravel(context: common.Context, route: ActionDecision): Promise<boolean> {
    const depart = FastLocalActions.at(route);
    const title = `出行：${route.label}`;
    const ok = await FastLocalActions.addReminderAt(context, depart, title);
    const early = new Date(depart.year, depart.month - 1, depart.day, depart.hour, depart.minute - 60);
    if (ok && early.getTime() > Date.now()) {
      const before = new LocalDateTime();
      before.year = early.getFullYear();
      before.month = early.getMonth() + 1;
      before.day = early.getDate();
      before.hour = early.getHours();
      before.minute = early.getMinutes();
      await FastLocalActions.addReminderAt(context, before, `一小时后出发：${route.label}`);
    }
    return ok;
  }

  static deviceSummary(): string {
    const charging = batteryInfo.chargingStatus === batteryInfo.BatteryChargeState.ENABLE ? ',正在充电' :
      (batteryInfo.chargingStatus === batteryInfo.BatteryChargeState.FULL ? ',已充满' : '');
    return [
      `${deviceInfo.marketName}(${deviceInfo.productModel}),${deviceInfo.osFullName}`,
      `电量 ${batteryInfo.batterySOC}%${charging}`,
      nowLine(Date.now())
    ].join('\n');
  }

  static async copyText(text: string): Promise<boolean> {
    if (text.length === 0) {
      return false;
    }
    try {
      await pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text));
      return true;
    } catch (_err) {
      return false;
    }
  }

  static async setTorch(context: common.Context, on: boolean): Promise<boolean> {
    if (!await FastLocalActions.ask(context, 'ohos.permission.CAMERA')) {
      return false;
    }
    try {
      const mgr = camera.getCameraManager(context);
      if (!mgr.isTorchSupported()) {
        return false;
      }
      mgr.setTorchMode(on ? camera.TorchMode.ON : camera.TorchMode.OFF);
      taskStatus.setTorchOn(on);
      return true;
    } catch (_err) {
      return false;
    }
  }

  static async addTodo(context: common.Context, title: string): Promise<boolean> {
    const text = title.trim().length > 0 ? title.trim() : '待办';
    taskStatus.setLastTodo(text);
    // 原来发通知失败也报成功;现在如实返回,没记上就交给模型处理。
    return FastLocalActions.postNotice('待办', text);
  }

  /** 发一条通知。没开通知权限、系统拒绝时返回 false。 */
  static async postNotice(title: string, text: string): Promise<boolean> {
    if (text.trim().length === 0) {
      return false;
    }
    try {
      await notificationManager.requestEnableNotification();
      const req: notificationManager.NotificationRequest = {
        id: Math.abs(FastLocalActions.hash(`${title}\u0000${text}`)) % 100000,
        content: {
          notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
          normal: {
            title: title,
            text: text
          }
        }
      };
      await notificationManager.publish(req);
      return true;
    } catch (_err) {
      return false;
    }
  }

  static async addAlarm(context: common.Context, route: ActionDecision): Promise<boolean> {
    if (route.hour < 0 || route.minute < 0) {
      return false;
    }
    if (!await FastLocalActions.ask(context, 'ohos.permission.PUBLISH_AGENT_REMINDER')) {
      return false;
    }
    try {
      const reminder: reminderAgentManager.ReminderRequestAlarm = {
        reminderType: reminderAgentManager.ReminderType.REMINDER_TYPE_ALARM,
        hour: route.hour,
        minute: route.minute,
        title: route.label.length > 0 ? route.label : '闹钟',
        ringDuration: 5,
        snoozeTimes: 1,
        timeInterval: 0,
        actionButton: [
          {
            title: '关闭',
            type: reminderAgentManager.ActionButtonType.ACTION_BUTTON_TYPE_CLOSE
          }
        ],
        wantAgent: {
          pkgName: PKG,
          abilityName: ABILITY
        }
      };
      await reminderAgentManager.publishReminder(reminder);
      return true;
    } catch (_err) {
      return false;
    }
  }

  static async addCalendar(context: common.Context, route: ActionDecision): Promise<boolean> {
    if (route.hour < 0 || route.minute < 0) {
      return false;
    }
    const when = new Date();
    if (route.tomorrow) {
      when.setDate(when.getDate() + 1);
    }
    const at = new LocalDateTime();
    at.year = when.getFullYear();
    at.month = when.getMonth() + 1;
    at.day = when.getDate();
    at.hour = route.hour;
    at.minute = route.minute;
    return FastLocalActions.addReminderAt(context, at, route.label.length > 0 ? route.label : '日程');
  }

  /** 在指定的本地时间发一条系统提醒(不是日历日程:读写整个日历要受限权限)。 */
  static async addReminderAt(context: common.Context, at: LocalDateTime, title: string): Promise<boolean> {
    if (!await FastLocalActions.ask(context, 'ohos.permission.PUBLISH_AGENT_REMINDER')) {
      return false;
    }
    try {
      const reminder: reminderAgentManager.ReminderRequestCalendar = {
        reminderType: reminderAgentManager.ReminderType.REMINDER_TYPE_CALENDAR,
        dateTime: {
          year: at.year,
          month: at.month,
          day: at.day,
          hour: at.hour,
          minute: at.minute,
          second: 0
        },
        title: title,
        actionButton: [
          {
            title: '关闭',
            type: reminderAgentManager.ActionButtonType.ACTION_BUTTON_TYPE_CLOSE
          }
        ],
        wantAgent: {
          pkgName: PKG,
          abilityName: ABILITY
        }
      };
      await reminderAgentManager.publishReminder(reminder);
      return true;
    } catch (_err) {
      return false;
    }
  }

  private static async ask(context: common.Context, perm: Permissions): Promise<boolean> {
    try {
      const at = abilityAccessCtrl.createAtManager();
      const grant = await at.requestPermissionsFromUser(context, [perm]);
      return grant.authResults.length > 0 && grant.authResults[0] === 0;
    } catch (_err) {
      return false;
    }
  }

  private static hash(text: string): number {
    let n = 0;
    for (let i = 0; i < text.length; i++) {
      n = ((n << 5) - n) + text.charCodeAt(i);
      n |= 0;
    }
    return n;
  }
}
