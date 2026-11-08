import { liveViewManager } from '@kit.LiveViewKit';

/** Generic task progress requires Huawei's PROGRESS scenario entitlement. */
export class TaskLiveView {
  static error: string = '';
  private static sequences: Map<number, number> = new Map();
  private static queue: Promise<void> = Promise.resolve();

  static update(id: number, state: string, finished: boolean): Promise<void> {
    const next = TaskLiveView.queue.catch(() => {}).then(() => TaskLiveView.apply(id, state, finished));
    TaskLiveView.queue = next;
    return next;
  }

  private static async apply(id: number, state: string, finished: boolean): Promise<void> {
    if (!Number.isInteger(id) || id < 0 || id > 2147483647) {
      throw new Error('invalid live view id');
    }
    try {
      if (!await liveViewManager.isLiveViewEnabled()) {
        throw new Error('实况窗未开启');
      }
      let sequence = TaskLiveView.sequences.get(id);
      if (sequence === undefined) {
        try {
          const previous = await liveViewManager.getActiveLiveView(id);
          if (previous.sequence !== undefined && previous.sequence < 2147483647) {
            sequence = previous.sequence;
          }
        } catch (_err) {
          // A new task has no active live view.
        }
      }
      const version = (sequence ?? 0) + 1;
      const view: liveViewManager.LiveView = {
        id: id, event: 'PROGRESS', sequence: version, isMute: true,
        lifeCycleMode: liveViewManager.LifeCycleMode.AUTO_STOP_WHEN_APP_TERMINATE,
        liveViewData: { primary: { title: 'LeoBot', content: [{ text: state.slice(0, 200) }],
          keepTime: finished ? 60 : 0, aliveTime: 10 } }
      };
      if (finished && sequence === undefined) {
        return;
      }
      const result = finished ? await liveViewManager.stopLiveView(view) :
        sequence === undefined ? await liveViewManager.startLiveView(view) :
          await liveViewManager.updateLiveView(view);
      if (result.resultCode !== 0) {
        throw new Error('实况窗调用失败');
      }
      if (finished) {
        TaskLiveView.sequences.delete(id);
      } else {
        TaskLiveView.sequences.set(id, version);
      }
      TaskLiveView.error = '';
    } catch (_err) {
      TaskLiveView.error = '实况窗不可用，请检查系统开关与 PROGRESS 场景资格';
      throw new Error(TaskLiveView.error);
    }
  }
}
