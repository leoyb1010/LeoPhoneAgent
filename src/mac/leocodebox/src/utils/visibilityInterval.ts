type VisibleTask = {
  callback: () => void;
  intervalMs: number;
  nextAt: number;
};

const tasks = new Map<number, VisibleTask>();
let nextTaskId = 1;
let schedulerTimer: number | null = null;
let visibilityListenerAttached = false;

function clearSchedulerTimer() {
  if (schedulerTimer !== null) {
    window.clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}

function scheduleNextTick() {
  clearSchedulerTimer();
  if (tasks.size === 0 || document.visibilityState !== 'visible') return;
  const now = Date.now();
  const nextAt = Math.min(...[...tasks.values()].map((task) => task.nextAt));
  schedulerTimer = window.setTimeout(runDueTasks, Math.max(0, nextAt - now));
}

function runDueTasks() {
  schedulerTimer = null;
  if (document.visibilityState !== 'visible') return;
  const now = Date.now();
  for (const task of tasks.values()) {
    if (task.nextAt > now) continue;
    task.nextAt = now + task.intervalMs;
    try {
      task.callback();
    } catch (error) {
      // Keep the shared scheduler alive when one optional poller fails.
      console.error('[VisiblePollScheduler] callback failed:', error);
    }
  }
  scheduleNextTick();
}

function onVisibilityChange() {
  clearSchedulerTimer();
  if (document.visibilityState !== 'visible') return;
  const now = Date.now();
  for (const task of tasks.values()) {
    task.nextAt = now + task.intervalMs;
    try {
      task.callback();
    } catch (error) {
      console.error('[VisiblePollScheduler] callback failed:', error);
    }
  }
  scheduleNextTick();
}

function ensureVisibilityListener() {
  if (visibilityListenerAttached) return;
  document.addEventListener('visibilitychange', onVisibilityChange);
  visibilityListenerAttached = true;
}

function releaseVisibilityListenerIfIdle() {
  if (!visibilityListenerAttached || tasks.size > 0) return;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  visibilityListenerAttached = false;
  clearSchedulerTimer();
}

/**
 * Register a low-frequency fallback poll on the app-wide visible-page scheduler.
 * WebSocket/event updates remain primary; every fallback shares one timer and one
 * visibility lifecycle, pauses while hidden, and refreshes immediately on resume.
 */
export function startVisibleInterval(callback: () => void, intervalMs: number): () => void {
  const id = nextTaskId++;
  const normalizedInterval = Math.max(1_000, intervalMs);
  tasks.set(id, {
    callback,
    intervalMs: normalizedInterval,
    nextAt: Date.now() + normalizedInterval,
  });
  ensureVisibilityListener();
  scheduleNextTick();

  return () => {
    tasks.delete(id);
    releaseVisibilityListenerIfIdle();
    scheduleNextTick();
  };
}
