import { abilityAccessCtrl, common, Permissions } from '@kit.AbilityKit';
import { camera } from '@kit.CameraKit';
import { reminderAgentManager } from '@kit.BackgroundTasksKit';
import { notificationManager } from '@kit.NotificationKit';
import { ActionDecision, ActionRouter } from './ActionRouter';
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
  static async tryRoute(context: common.UIAbilityContext, text: string, imageCount: number): Promise<string> {
    const route = ActionRouter.decide(text, imageCount);
    if (route.path !== 'native') {
      return '';
    }
    let ok = false;
    if (route.kind === 'toggleFlashlight') {
      ok = await FastLocalActions.setTorch(context, route.label !== 'off');
    } else if (route.kind === 'createTodo') {
      ok = await FastLocalActions.addTodo(context, route.label);
    } else if (route.kind === 'setAlarm') {
      ok = await FastLocalActions.addAlarm(context, route);
    } else if (route.kind === 'createCalendar') {
      ok = await FastLocalActions.addCalendar(context, route);
    }
    return ok ? ActionRouter.spoken(route) : '';
  }

  static async setTorch(context: common.UIAbilityContext, on: boolean): Promise<boolean> {
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

  static async addTodo(context: common.UIAbilityContext, title: string): Promise<boolean> {
    const text = title.trim().length > 0 ? title.trim() : '待办';
    taskStatus.setLastTodo(text);
    try {
      await notificationManager.requestEnableNotification();
      const req: notificationManager.NotificationRequest = {
        id: Math.abs(FastLocalActions.hash(text)) % 100000,
        content: {
          notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
          normal: {
            title: '待办',
            text: text
          }
        }
      };
      await notificationManager.publish(req);
      return true;
    } catch (_err) {
      return true;
    }
  }

  static async addAlarm(context: common.UIAbilityContext, route: ActionDecision): Promise<boolean> {
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

  static async addCalendar(context: common.UIAbilityContext, route: ActionDecision): Promise<boolean> {
    if (route.hour < 0 || route.minute < 0) {
      return false;
    }
    if (!await FastLocalActions.ask(context, 'ohos.permission.PUBLISH_AGENT_REMINDER')) {
      return false;
    }
    const when = new Date();
    if (route.tomorrow) {
      when.setDate(when.getDate() + 1);
    }
    when.setHours(route.hour, route.minute, 0, 0);
    try {
      const reminder: reminderAgentManager.ReminderRequestCalendar = {
        reminderType: reminderAgentManager.ReminderType.REMINDER_TYPE_CALENDAR,
        dateTime: {
          year: when.getFullYear(),
          month: when.getMonth() + 1,
          day: when.getDate(),
          hour: route.hour,
          minute: route.minute,
          second: 0
        },
        title: route.label.length > 0 ? route.label : '日程',
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

  private static async ask(context: common.UIAbilityContext, perm: Permissions): Promise<boolean> {
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
