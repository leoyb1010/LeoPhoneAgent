/** Same native-intent contract as Android ActionRouter / iOS ActionRouter. */

export type ActionPath = "native" | "agent"
export type ActionKind =
  | "savePhoto"
  | "setAlarm"
  | "createCalendar"
  | "toggleFlashlight"
  | "createTodo"

export type ActionDecision = {
  path: ActionPath
  kind: ActionKind | null
  hour: number | null
  minute: number | null
  tomorrow: boolean
  label: string
}

const PHOTO = [
  "相册", "相簿", "save to album", "save to photos",
  "save this photo", "save this image", "save the photo",
  "save the image", "存进相册", "保存到相册", "存到相册", "放到相册",
]
const CALENDAR = [
  "加到日历", "写入日历", "添加到日历", "加进日历",
  "add to calendar", "create calendar event", "创建日程",
]
const TORCH_OFF = [
  "关掉手电筒", "关闭手电筒", "关手电筒", "关上手电筒",
  "turn off flashlight", "turn off the flashlight", "turn off torch",
  "flashlight off", "torch off",
]
const TORCH_ON = [
  "打开手电筒", "开手电筒", "打开手电", "开手电",
  "turn on flashlight", "turn on the flashlight", "turn on torch",
  "flashlight on", "torch on",
]
const TODO = [
  "记个待办", "记一条待办", "添加待办", "写个待办",
  "add a todo", "add todo", "remind me to",
]

function hasAny(lower: string, needles: string[]): boolean {
  for (let i = 0; i < needles.length; i++) {
    if (lower.includes(needles[i])) return true
  }
  return false
}

function two(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

export function chipOf(kind: ActionKind | null): string {
  if (kind === "savePhoto") return "系统相册"
  if (kind === "setAlarm") return "系统闹钟"
  if (kind === "createCalendar") return "系统日历"
  if (kind === "toggleFlashlight") return "手电筒"
  if (kind === "createTodo") return "待办"
  return ""
}

export function spokenOf(d: ActionDecision): string {
  if (d.kind === "savePhoto") return "已用系统相册保存，未打开界面。"
  if (d.kind === "setAlarm") {
    const hh = d.hour == null ? "--" : two(d.hour)
    const mm = d.minute == null ? "--" : two(d.minute)
    return `已用系统闹钟设定 ${hh}:${mm}，未打开界面。`
  }
  if (d.kind === "createCalendar") return "已用系统日历创建日程，未打开界面。"
  if (d.kind === "toggleFlashlight") return d.label === "off" ? "已关掉手电筒。" : "已打开手电筒。"
  if (d.kind === "createTodo") return `已记下待办：${d.label || "待办"}。`
  return ""
}

function agent(): ActionDecision {
  return { path: "agent", kind: null, hour: null, minute: null, tomorrow: false, label: "" }
}

function native(kind: ActionKind, extra: Partial<ActionDecision> = {}): ActionDecision {
  return {
    path: "native",
    kind,
    hour: extra.hour ?? null,
    minute: extra.minute ?? null,
    tomorrow: extra.tomorrow ?? false,
    label: extra.label ?? "",
  }
}

export function isSavePhoto(lower: string): boolean {
  return hasAny(lower, PHOTO)
}

export function isCalendar(lower: string): boolean {
  return hasAny(lower, CALENDAR)
}

export function flashlightOn(lower: string): boolean | null {
  if (hasAny(lower, TORCH_OFF)) return false
  if (hasAny(lower, TORCH_ON)) return true
  return null
}

export function isTodo(lower: string): boolean {
  return hasAny(lower, TODO)
}

export function isTomorrow(lower: string): boolean {
  return lower.includes("明早") || lower.includes("明天") ||
    lower.includes("tomorrow") || lower.includes("tmrw")
}

function valid(hour: number, minute: number): [number, number] | null {
  if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return [hour, minute]
  return null
}

function adjustHour(hour: number, lower: string, at: number): number {
  const prefix = lower.slice(0, Math.min(at, lower.length))
  const morning = prefix.includes("早") || prefix.includes("上午") || prefix.includes("am")
  const evening = prefix.includes("晚") || prefix.includes("下午") || prefix.includes("pm")
  if (evening && hour >= 1 && hour <= 11) return hour + 12
  if (morning && hour === 12) return 0
  return hour
}

export function parseTime(raw: string, lower = raw.toLowerCase()): [number, number] | null {
  const colon = raw.match(/(\d{1,2})[:：](\d{2})/)
  if (colon && colon.index != null) {
    const h = adjustHour(Number(colon[1]), lower, colon.index)
    return valid(h, Number(colon[2]))
  }
  const zh = raw.match(/(\d{1,2})\s*点\s*(\d{1,2})?\s*分?/)
  if (zh && zh.index != null) {
    const h = adjustHour(Number(zh[1]), lower, zh.index)
    const min = zh[2] ? Number(zh[2]) : 0
    return valid(h, min)
  }
  const ampm = lower.match(/\b(\d{1,2})\s*([ap])m\b/)
  if (ampm) {
    let h = Number(ampm[1])
    if (ampm[2] === "p" && h < 12) h += 12
    if (ampm[2] === "a" && h === 12) h = 0
    return valid(h, 0)
  }
  return null
}

export function isAlarm(raw: string, lower: string): boolean {
  if (isCalendar(lower)) return false
  const hit = lower.includes("闹钟") ||
    /\bset alarm\b/.test(lower) ||
    /\balarm (for|at)\b/.test(lower)
  return hit && parseTime(raw, lower) != null
}

function strip(raw: string, pattern: RegExp): string {
  return raw.replace(pattern, "").replace(/^[\s，,。.：:]+|[\s，,。.：:]+$/g, "")
}

function alarmLabel(raw: string): string {
  const out = strip(
    raw,
    /明早|明天|tomorrow|tmrw|闹钟|set alarm|alarm for|alarm at/gi,
  )
  return strip(out, /\d{1,2}[:：]\d{2}/).replace(/\d{1,2}\s*点\s*\d{0,2}\s*分?/g, "").trim() || "闹钟"
}

function calendarTitle(raw: string): string {
  const out = strip(
    raw,
    /加到日历|写入日历|添加到日历|加进日历|add to calendar|create calendar event|创建日程/gi,
  )
  const noDay = strip(out, /明早|明天|tomorrow|tmrw/gi)
  return strip(noDay, /\d{1,2}[:：]\d{2}/).replace(/\d{1,2}\s*点\s*\d{0,2}\s*分?/g, "").trim() || "日程"
}

function todoTitle(raw: string): string {
  return strip(
    raw,
    /记个待办|记一条待办|添加待办|写个待办|add a todo|add todo|remind me to/gi,
  ) || "待办"
}

export function decide(text: string, imageCount: number): ActionDecision {
  const raw = text.trim()
  const lower = raw.toLowerCase()
  if (imageCount > 0 && isSavePhoto(lower)) return native("savePhoto")
  const torch = flashlightOn(lower)
  if (torch != null) return native("toggleFlashlight", { label: torch ? "on" : "off" })
  if (isTodo(lower)) return native("createTodo", { label: todoTitle(raw) })
  if (isAlarm(raw, lower)) {
    const time = parseTime(raw, lower)
    if (!time) return agent()
    return native("setAlarm", {
      hour: time[0],
      minute: time[1],
      tomorrow: isTomorrow(lower),
      label: alarmLabel(raw),
    })
  }
  if (isCalendar(lower)) {
    const time = parseTime(raw, lower)
    if (!time) return agent()
    return native("createCalendar", {
      hour: time[0],
      minute: time[1],
      tomorrow: isTomorrow(lower),
      label: calendarTitle(raw),
    })
  }
  return agent()
}
