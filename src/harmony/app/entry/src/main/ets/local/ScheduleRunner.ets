import { common } from '@kit.AbilityKit';
import { workScheduler } from '@kit.BackgroundTasksKit';
import { ChatRuns } from './ChatRun';
import { LocalAgentEngine } from './LocalAgentEngine';
import { LocalTools } from './LocalTools';
import { doneNotice } from './AgentText';
import { ScheduleStore, ScheduleTask, scheduleStore } from '../store/ScheduleStore';
import { sessionStore } from '../store/SessionStore';

const WORK_ID = 7101;

/**
 * 定时任务的执行:界面在前台时由 EntryAbility 每 30 秒叫一次,App 关着或在后台时由系统唤起的 ScheduleWork 叫。
 * 到点、今天还没跑过的一个个跑(错过的回来补今天这一次),结果写进「定时·标题」对话;在后台跑完的发一条通知。
 */
export class ScheduleRunner {
  static busy: boolean = false;

  static async runDue(context: common.Context, notify: boolean): Promise<number> {
    if (ScheduleRunner.busy) {
      return 0;
    }
    ScheduleRunner.busy = true;
    try {
      await scheduleStore.load(context);
      const rows = scheduleStore.dueNow();
      for (let i = 0; i < rows.length; i++) {
        await ScheduleRunner.runOne(context, rows[i], notify);
      }
      return rows.length;
    } finally {
      ScheduleRunner.busy = false;
    }
  }

  /**
   * 有开着的定时任务就向系统登记一个延迟任务,让它在 App 关着时也定期唤起 ScheduleWork;没有就撤掉。
   * ponytail: 系统按 App 的活跃程度决定多久唤起一次(常用的 App 约 2 小时起),时间不精确;
   * 要准点得靠常驻后台,那要长时任务和常驻通知,先不做。
   */
  static async syncWork(context: common.Context): Promise<void> {
    const work: workScheduler.WorkInfo = {
      workId: WORK_ID,
      bundleName: context.applicationInfo.name,
      abilityName: 'ScheduleWork',
      isRepeat: true,
      repeatCycleTime: 30 * 60 * 1000,
      networkType: workScheduler.NetworkType.NETWORK_TYPE_ANY,
      isPersisted: true
    };
    const wanted = scheduleStore.rows.some((row: ScheduleTask) => row.on);
    let registered = false;
    try {
      await workScheduler.getWorkStatus(WORK_ID);
      registered = true;
    } catch (_err) {
      registered = false;
    }
    // 已经登记着就别动:每次回前台都重新登记会把系统的计时一直往后推。
    try {
      if (wanted && !registered) {
        workScheduler.startWork(work);
      } else if (!wanted && registered) {
        workScheduler.stopWork(work, true);
      }
    } catch (_err) {
      // 登记不上就只在前台跑
    }
  }

  private static async runOne(context: common.Context, row: ScheduleTask, notify: boolean): Promise<void> {
    await LocalTools.hydrate(context);
    await sessionStore.ensureLoaded(context);
    let sessionId = row.sessionId;
    if (!sessionId || !await sessionStore.get(context, sessionId)) {
      const session = await sessionStore.create(context, ScheduleStore.sessionTitle(row.title));
      sessionId = session.id;
    }
    await sessionStore.append(context, sessionId, 'user', row.prompt);
    const mine = LocalAgentEngine.bump('schedule');
    const outcome = await new Promise<string[]>((resolve: (value: string[]) => void) => {
      // 看门狗:LocalAgentEngine 在「这一轮已经被换代」时直接 return、一个回调都不调;
      // 这里只负责不让调度卡死,回合真跑完时照样会写会话和结果。
      const guard = setTimeout(() => {
        resolve(['failed', '超过 10 分钟没跑完']);
      }, 10 * 60 * 1000);
      LocalAgentEngine.run(context, 'schedule', mine, row.prompt, '', () => {
        // 定时任务没有页面在看
      }, (output: string) => {
        clearTimeout(guard);
        resolve(['done', output]);
      }, (message: string) => {
        clearTimeout(guard);
        resolve(['failed', message]);
      });
    });
    const ok = outcome[0] === 'done';
    await sessionStore.append(context, sessionId, ok ? 'assistant' : 'system', outcome[1]).catch(() => {
      // 接着跑下一个
    });
    await scheduleStore.record(context, row.rowId, sessionId, ok ? outcome[1] : '', ok ? '' : outcome[1])
      .catch(() => {
        // 接着跑下一个
      });
    if (notify) {
      await ChatRuns.notify(sessionId, doneNotice(outcome[0], ScheduleStore.sessionTitle(row.title), outcome[1]))
        .catch(() => {
          // 没开通知权限
        });
    }
  }
}
