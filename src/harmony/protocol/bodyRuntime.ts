export type ScheduleRow = {
  rowId: string
  hour: number
  minute: number
  on: boolean
  lastDay: string
}

/**
 * 事件信封:每条事件都补 `seq` / `session_id` / `timestamp`。
 *
 * **`timestamp` 是秒,不是毫秒。** 四端必须一致:
 * - Mac TS  `harness-session.service.ts` → `Date.now() / 1000`
 * - Mac Py  `harness.py`                 → `time.time()`
 * - Android `MinisHarnessRouter.kt`      → `System.currentTimeMillis() / 1000.0`
 * - 鸿蒙     `HarmonyMinisRouter.ets`     → `Date.now() / 1000`
 *
 * 默认值就地算出来,不让调用方传 —— 调用方传参正是秒/毫秒混用的入口。
 */
export function enrichEvent(
  raw: string,
  seq: number,
  sessionId: string,
  timestamp: number = nowSeconds(),
): string {
  const obj = JSON.parse(raw) as Record<string, unknown>
  obj.seq = seq
  obj.session_id = sessionId
  obj.timestamp = timestamp
  return JSON.stringify(obj)
}

/** 事件信封的时间戳:秒(带小数),不是毫秒。 */
export function nowSeconds(): number {
  return Date.now() / 1000
}

/**
 * `?after=N` 的补齐语义:**严格大于 N**,不是 >=。
 *
 * Mac 是 `Number(event.seq ?? 0) > afterSeq`(harness-session.service.ts),
 * Python 是 `event.get("seq", 0) > after_seq`,Android 是 `it.optInt("seq") > after`。
 * seq 从 1 开始(第一条永远是 `session.created`),所以 `after=0` 等于全量重放。
 *
 * iOS 收到重复事件不会按 seq 去重(`LeoAgentHarness` 只做 `max`),一旦这里
 * 写成 >= ,重连后整条对话会被重复渲染一遍。
 */
export function replayAfter(events: string[], after: number): string[] {
  const out: string[] = []
  for (let i = 0; i < events.length; i++) {
    if (i + 1 > after) out.push(events[i])
  }
  return out
}

export function dayKey(stamp: number): string {
  const date = new Date(stamp)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

/** Tasks whose clock time fell in (lastTick, now], not yet marked today. */
export function scheduleSessionTitle(title: string): string {
  const name = title.trim() || "任务"
  return `定时·${name}`
}

export function lastRunLabel(lastRunAt: number, lastResult: string, lastError: string, now: number = Date.now()): string {
  if (lastError.trim().length > 0) {
    const cut = lastError.trim().length > 80 ? `${lastError.trim().slice(0, 80)}…` : lastError.trim()
    return `失败 · ${cut}`
  }
  if (lastRunAt <= 0) return "还没跑过"
  const mins = Math.max(0, Math.floor((now - lastRunAt) / 60000))
  const when = mins < 1 ? "刚刚" : mins < 60 ? `${mins} 分钟前` : `${Math.floor(mins / 60)} 小时前`
  const result = lastResult.trim().length > 40 ? `${lastResult.trim().slice(0, 40)}…` : lastResult.trim()
  return result.length > 0 ? `上次 ${when} · ${result}` : `上次 ${when}`
}

export function dueTasks(rows: ScheduleRow[], now: number, lastTick: number): ScheduleRow[] {
  const today = dayKey(now)
  const windowStart = lastTick > 0 ? lastTick : now - 60_000
  const out: ScheduleRow[] = []
  for (const row of rows) {
    if (!row.on || row.lastDay === today) continue
    const fire = new Date(now)
    fire.setHours(row.hour, row.minute, 0, 0)
    const fireAt = fire.getTime()
    if (fireAt > windowStart && fireAt <= now) {
      out.push(row)
    }
  }
  return out
}
