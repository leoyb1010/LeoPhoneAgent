/**
 * home 的 schedule-index hydration 延后器。
 *
 * device-link 是并发多路复用、无优先级,所有响应走同一条 WS 管道。home 进入时若立刻 fire-and-forget
 * 发 `schedule.list()` + 每个 schedule 一次 `listRuns`(1+N,约 10 个),用户随即点进会话时,会话关键读
 * (messages / getSession / projection / pending)的响应会排在这 1+N 个背景响应后面 → 开会话变慢
 * (实测 messages:list 一次 11s)。
 *
 * schedule-index 只喂 home 的次要标记(自动化行的"运行中"脉冲——另有 isSessionRunning 兜底——和未读/
 * 待处理小点;自动化分组与名称已由 fallbackScheduleInfo 用 source/title 兜底,不依赖它)。所以可以"晚半拍"
 * 出现。这里把它延后一小段,避开"开 app → 立刻点进会话"的关键窗口,让会话关键读先抢到管道。
 *
 * 治本(device-link 加请求优先级)见 issue #324,本延后只是低风险小改。
 */

// 延后时长:覆盖"开 app → 立刻点会话"后会话屏发出关键读的窗口;之后再补发 schedule 背景拉取。
export const SCHEDULE_INDEX_HYDRATION_DEFER_MS = 800;

/**
 * 延后执行 `run`,返回一个 cancel(用于卸载时清理,避免 setState-after-unmount)。
 * 纯定时器封装,便于单测(假定时器下:到点前不调用、到点后调用、cancel 后不调用)。
 */
export function deferScheduleIndexHydration(
  run: () => void,
  delayMs: number = SCHEDULE_INDEX_HYDRATION_DEFER_MS,
): () => void {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
}

/** 按 key(设备 id)索引的延后任务登记表。 */
export interface ScheduleIndexDeferRegistry {
  /** 为 key 登记一个延后任务;若该 key 上一轮还没执行,先取消它。 */
  schedule: (key: string, run: () => void, delayMs?: number) => void;
  /** 取消所有在途延后任务并清空(组件卸载时调用)。 */
  cancelAll: () => void;
}

/**
 * 创建按 key 索引的延后任务登记表,解决 schedule-index hydration 的并发覆盖竞态。
 *
 * 同一设备在延后窗口(800ms)内可能被多次 hydrate(首次加载 / presence 更新 / 重连自愈 / 手动刷新)。
 * 若不取消上一轮 pending 的延后任务,较早的回调仍会用它捕获的旧快照覆盖新状态。`schedule()` 在为同一
 * key 注册新任务前先取消该 key 上一轮还没执行的任务,保证每个 key 最多只有一个在途延后任务,且总是用
 * 最新一次的闭包。`defer` 可注入以便单测。
 */
export function createScheduleIndexDeferRegistry(
  defer: (run: () => void, delayMs?: number) => () => void = deferScheduleIndexHydration,
): ScheduleIndexDeferRegistry {
  const cancels = new Map<string, () => void>();
  return {
    schedule(key, run, delayMs) {
      // 先取消该 key 上一轮还没执行的延后任务,避免旧快照覆盖新状态。
      cancels.get(key)?.();
      const cancel = defer(() => {
        // 仅当登记的仍是本次句柄时才删除,避免误删同 key 更晚注册的任务句柄。
        if (cancels.get(key) === cancel) cancels.delete(key);
        run();
      }, delayMs);
      cancels.set(key, cancel);
    },
    cancelAll() {
      for (const cancel of cancels.values()) cancel();
      cancels.clear();
    },
  };
}
