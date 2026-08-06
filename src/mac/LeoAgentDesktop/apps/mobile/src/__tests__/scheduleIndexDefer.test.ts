import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createScheduleIndexDeferRegistry,
  deferScheduleIndexHydration,
  SCHEDULE_INDEX_HYDRATION_DEFER_MS,
} from '@/session/scheduleIndexDefer';

describe('deferScheduleIndexHydration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not run before the defer delay elapses', () => {
    const run = vi.fn();
    deferScheduleIndexHydration(run);
    vi.advanceTimersByTime(SCHEDULE_INDEX_HYDRATION_DEFER_MS - 1);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs once the defer delay elapses', () => {
    const run = vi.fn();
    deferScheduleIndexHydration(run);
    vi.advanceTimersByTime(SCHEDULE_INDEX_HYDRATION_DEFER_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('honors a custom delay', () => {
    const run = vi.fn();
    deferScheduleIndexHydration(run, 200);
    vi.advanceTimersByTime(199);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not run after cancel', () => {
    const run = vi.fn();
    const cancel = deferScheduleIndexHydration(run);
    cancel();
    vi.advanceTimersByTime(SCHEDULE_INDEX_HYDRATION_DEFER_MS * 2);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('createScheduleIndexDeferRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs each key once after the delay', () => {
    const registry = createScheduleIndexDeferRegistry();
    const runA = vi.fn();
    const runB = vi.fn();
    registry.schedule('device-a', runA);
    registry.schedule('device-b', runB);
    vi.advanceTimersByTime(SCHEDULE_INDEX_HYDRATION_DEFER_MS);
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(1);
  });

  // 并发覆盖回归:同一设备在延后窗口内被多次 hydrate 时,只有最后一次的回调能执行,
  // 较早的回调(捕获旧 nextSessions)必须被取消,否则旧快照会覆盖新状态。
  it('cancels the prior pending task when the same key is scheduled again', () => {
    const registry = createScheduleIndexDeferRegistry();
    const stale = vi.fn();
    const fresh = vi.fn();
    registry.schedule('device-a', stale);
    // 在延后窗口内再次 hydrate 同一设备(presence / 重连自愈 / 手动刷新)。
    vi.advanceTimersByTime(SCHEDULE_INDEX_HYDRATION_DEFER_MS - 1);
    registry.schedule('device-a', fresh);
    vi.advanceTimersByTime(SCHEDULE_INDEX_HYDRATION_DEFER_MS);
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('allows scheduling the same key again after the previous task fired', () => {
    const registry = createScheduleIndexDeferRegistry();
    const first = vi.fn();
    const second = vi.fn();
    registry.schedule('device-a', first);
    vi.advanceTimersByTime(SCHEDULE_INDEX_HYDRATION_DEFER_MS);
    expect(first).toHaveBeenCalledTimes(1);
    registry.schedule('device-a', second);
    vi.advanceTimersByTime(SCHEDULE_INDEX_HYDRATION_DEFER_MS);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('cancelAll cancels every pending task', () => {
    const registry = createScheduleIndexDeferRegistry();
    const runA = vi.fn();
    const runB = vi.fn();
    registry.schedule('device-a', runA);
    registry.schedule('device-b', runB);
    registry.cancelAll();
    vi.advanceTimersByTime(SCHEDULE_INDEX_HYDRATION_DEFER_MS * 2);
    expect(runA).not.toHaveBeenCalled();
    expect(runB).not.toHaveBeenCalled();
  });
});
