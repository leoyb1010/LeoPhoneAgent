import { WorkSchedulerExtensionAbility, workScheduler } from '@kit.BackgroundTasksKit';
import { ScheduleRunner } from '../local/ScheduleRunner';
import { UiState } from '../store/UiState';

/**
 * App 关着或在后台时,系统按登记的延迟任务唤起这里,把到点的定时任务跑掉、发通知。
 * 界面在前台时让开(那边自己每 30 秒跑一次),免得两个进程同时写对话档案。
 */
export default class ScheduleWork extends WorkSchedulerExtensionAbility {
  onWorkStart(_work: workScheduler.WorkInfo): void {
    if (UiState.uiBusy(this.context)) {
      return;
    }
    ScheduleRunner.runDue(this.context, true).then((count: number) => {
      if (count > 0) {
        UiState.markWorker(this.context);
      }
    }).catch(() => {
      // 下次唤起再试
    });
  }

  onWorkStop(_work: workScheduler.WorkInfo): void {
    // 系统叫停时没有要收尾的:跑到一半的那条下次按「今天还没跑过」再跑
  }
}
