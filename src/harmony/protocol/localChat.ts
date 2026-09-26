export type LocalChatMessage = {
  role: string
  text: string
  imageB64?: string
  imageMime?: string
  imagePath?: string
  kind?: string
  count?: number
  files?: string[]
}

export type LocalSessionArchive = {
  title: string
  messages: LocalChatMessage[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function normalizeProviderRoot(raw: string): string {
  return raw.trim().replace(/\/+$/, "")
}

export function isPrivateHttpHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1") return true
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h)) return true
  return false
}

export function requireProviderRoot(raw: string): string {
  const root = normalizeProviderRoot(raw)
  const lower = root.toLowerCase()
  if (lower.startsWith("https://")) {
    const rest = root.slice("https://".length)
    if (!rest || rest.includes("@") || rest.includes(" ") || rest.includes("#")) {
      throw new Error("AI 服务商地址不合法")
    }
    return root
  }
  if (lower.startsWith("http://")) {
    const hostPort = root.slice("http://".length).split("/")[0] ?? ""
    const host = hostPort.startsWith("[")
      ? (hostPort.match(/^(\[[^\]]+\])/)?.[1] ?? "")
      : hostPort.split(":")[0]
    if (isPrivateHttpHost(host)) {
      return root
    }
    throw new Error("AI 服务商地址只能是 https，或本机/局域网 http")
  }
  throw new Error("AI 服务商地址必须是 https://")
}

export function chatCompletionsUrl(root: string): string {
  return `${normalizeProviderRoot(root)}/chat/completions`
}

export function providerWire(type: string, root: string): string {
  const host = root.toLowerCase()
  if (type === "anthropic" && host.includes("api.anthropic.com")) return "anthropic"
  if (type === "gemini" && host.includes("generativelanguage.googleapis.com") && !host.includes("/openai")) {
    return "gemini"
  }
  return "openai"
}

export function anthropicMessagesUrl(root: string): string {
  const base = normalizeProviderRoot(root)
  return base.endsWith("/messages") ? base : `${base}/messages`
}

export function geminiStreamUrl(root: string, model: string): string {
  return `${normalizeProviderRoot(root)}/models/${model}:streamGenerateContent?alt=sse`
}

export function anthropicDeltaFromJson(json: unknown): string {
  const obj = asRecord(json)
  if (!obj || obj.type !== "content_block_delta") return ""
  const delta = asRecord(obj.delta)
  return delta && typeof delta.text === "string" ? delta.text : ""
}

export function geminiDeltaFromJson(json: unknown): string {
  const obj = asRecord(json)
  if (!obj || !Array.isArray(obj.candidates) || obj.candidates.length === 0) return ""
  const cand = asRecord(obj.candidates[0])
  const content = cand ? asRecord(cand.content) : null
  if (!content || !Array.isArray(content.parts)) return ""
  return content.parts.map((part) => {
    const row = asRecord(part)
    return row && typeof row.text === "string" ? row.text : ""
  }).join("")
}

export function openAiDeltaFromJson(json: unknown): string {
  const obj = asRecord(json)
  if (!obj || !Array.isArray(obj.choices) || obj.choices.length === 0) return ""
  const choice = asRecord(obj.choices[0])
  if (!choice) return ""
  const delta = asRecord(choice.delta)
  if (delta) {
    if (typeof delta.content === "string") return delta.content
    if (typeof delta.reasoning_content === "string") return ""
  }
  const message = asRecord(choice.message)
  if (message && typeof message.content === "string") return message.content
  return ""
}

export function openAiErrorFromJson(json: unknown): string {
  const obj = asRecord(json)
  if (!obj) return ""
  const err = asRecord(obj.error)
  if (err && typeof err.message === "string" && err.message) return err.message
  if (typeof obj.message === "string" && obj.message) return obj.message
  return ""
}

export function sessionArchiveFromJson(json: unknown): LocalSessionArchive | null {
  const obj = asRecord(json)
  if (!obj || !Array.isArray(obj.messages) || obj.messages.length === 0) return null
  const messages: LocalChatMessage[] = []
  for (const row of obj.messages) {
    const item = asRecord(row)
    if (!item) continue
    const role = typeof item.role === "string" ? item.role : ""
    const text =
      typeof item.text === "string"
        ? item.text
        : typeof item.content === "string"
          ? item.content
          : ""
    const imageB64 = typeof item.imageB64 === "string" ? item.imageB64 : ""
    const imagePath = typeof item.imagePath === "string" ? item.imagePath : ""
    if (!role || (!text.trim() && !imageB64 && !imagePath)) continue
    if (role !== "user" && role !== "assistant" && role !== "system") continue
    const imageMime = typeof item.imageMime === "string" ? item.imageMime : ""
    const kind = item.kind === "summary" || item.kind === "resume" || item.kind === "partial" ? item.kind : ""
    const files = Array.isArray(item.files) ? item.files.filter((f): f is string => typeof f === "string" && f.length > 0) : []
    messages.push({
      role,
      text: text.trim() || (imageB64 || imagePath ? "看这张图" : ""),
      imageB64,
      imageMime,
      imagePath,
      kind,
      count: Number(item.count ?? 0) || 0,
      files,
    })
  }
  if (messages.length === 0) return null
  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : messages[0].text.slice(0, 32)
  return { title, messages }
}

export function extractLinks(text: string): string[] {
  const out: string[] = []
  const re = /https?:\/\/[^\s<>)\]"']+/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const raw = match[0].replace(/[.,;:!?]+$/, "")
    try {
      const url = new URL(raw)
      if (url.protocol === "https:") {
        out.push(raw)
        continue
      }
      if (url.protocol === "http:" && isPrivateHttpHost(url.hostname)) {
        out.push(raw)
      }
    } catch {
      // skip
    }
  }
  return out
}

export function titleFromPrompt(text: string): string {
  const line = text.trim().replace(/\s+/g, " ")
  if (!line) return "新任务"
  return line.length > 32 ? `${line.slice(0, 32)}…` : line
}

export type DateBucket = "pinned" | "today" | "yesterday" | "week" | "month" | "earlier"

export function dateBucket(updatedAt: number, now: number = Date.now()): DateBucket {
  if (!updatedAt) return "earlier"
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const today = start.getTime()
  if (updatedAt >= today) return "today"
  if (updatedAt >= today - 86400000) return "yesterday"
  const diffDays = Math.floor((now - updatedAt) / 86400000)
  if (diffDays < 7) return "week"
  const monthAgo = new Date(now)
  monthAgo.setMonth(monthAgo.getMonth() - 1)
  if (updatedAt > monthAgo.getTime()) return "month"
  return "earlier"
}

export function relativeTime(stamp: number, now: number = Date.now()): string {
  if (!stamp) return ""
  const diff = now - stamp
  if (diff < 60_000) return "刚刚"
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(diff / 3_600_000)
  if (hours < 24) return `${hours} 小时前`
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  if (stamp >= start.getTime() - 86400000) return "昨天"
  if (diff < 7 * 86400000) {
    return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(stamp).getDay()]
  }
  const date = new Date(stamp)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

export function bucketTitle(bucket: DateBucket): string {
  switch (bucket) {
    case "pinned":
      return "置顶"
    case "today":
      return "今天"
    case "yesterday":
      return "昨天"
    case "week":
      return "本周"
    case "month":
      return "本月"
    default:
      return "更早"
  }
}

export const THINKING_LEVELS = ["", "low", "medium", "high"] as const

export function nextThinking(current: string): string {
  const idx = THINKING_LEVELS.indexOf(current as (typeof THINKING_LEVELS)[number])
  return THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length]
}

export type AccumToolCall = {
  index: number
  id: string
  name: string
  args: string
}

export const WRITE_GRANT_MARK = "__NEED_WRITE_GRANT__"

export function htmlToText(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
}

export function sandboxFileName(path: string): string {
  let raw = path.trim().replace(/^\/+/, "")
  if (raw.startsWith("workspace/")) raw = raw.slice("workspace/".length)
  if (raw.startsWith("var/minis/workspace/")) raw = raw.slice("var/minis/workspace/".length)
  if (!raw) throw new Error("文件名不能空")
  if (raw.includes("..") || raw.includes("/") || raw.includes("\\")) {
    throw new Error("只允许沙箱根目录下的文件名")
  }
  return raw
}

export function finishReasonFromJson(json: unknown): string {
  const obj = asRecord(json)
  if (!obj || !Array.isArray(obj.choices) || obj.choices.length === 0) return ""
  const choice = asRecord(obj.choices[0])
  if (!choice || typeof choice.finish_reason !== "string") return ""
  return choice.finish_reason
}

export function applyToolDelta(acc: AccumToolCall[], json: unknown): AccumToolCall[] {
  const obj = asRecord(json)
  if (!obj || !Array.isArray(obj.choices) || obj.choices.length === 0) return acc
  const choice = asRecord(obj.choices[0])
  if (!choice) return acc
  const delta = asRecord(choice.delta) ?? asRecord(choice.message)
  if (!delta || !Array.isArray(delta.tool_calls)) return acc
  const next = acc.map((row) => ({ ...row }))
  for (const row of delta.tool_calls) {
    const item = asRecord(row)
    if (!item) continue
    const index = typeof item.index === "number" ? item.index : next.length
    while (next.length <= index) {
      next.push({ index: next.length, id: "", name: "", args: "" })
    }
    const cur = next[index]
    if (typeof item.id === "string" && item.id) cur.id = item.id
    const fn = asRecord(item.function)
    if (fn) {
      if (typeof fn.name === "string" && fn.name) cur.name = cur.name || fn.name
      if (typeof fn.arguments === "string") cur.args += fn.arguments
    }
  }
  return next
}

/** 与 LocalProtocol.ets 保持一致:一次任务最多几轮工具,以及重复调用的提醒 / 停止次数。 */
export const MAX_TOOL_ROUNDS = 50
export const LOOP_WARN_AT = 3
export const LOOP_STOP_AT = 6

export class ToolLoopGuard {
  private counts = new Map<string, number>()

  note(name: string, args: string): number {
    const key = `${name}\u0000${args}`
    const times = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, times)
    return times
  }
}

export function loopWarning(name: string, times: number): string {
  return `\n(提醒:这是第 ${times} 次用同样的参数调用 ${name},结果不会变。换个做法,或者直接回答用户。)`
}

/** 与 LocalProtocol.ets 的 toolArgsComplete 保持一致:半截 JSON 的工具调用不执行。 */
export function toolArgsComplete(raw: string): boolean {
  if (raw.trim().length === 0) return true
  try {
    JSON.parse(raw)
    return true
  } catch {
    return false
  }
}

export function toolArg(raw: string, key: string): string {
  try {
    const obj = asRecord(JSON.parse(raw))
    if (!obj || obj[key] === undefined || obj[key] === null) return ""
    return typeof obj[key] === "object" ? JSON.stringify(obj[key]) : `${obj[key]}`
  } catch {
    return ""
  }
}

export function localToolNames(): string[] {
  return [
    "file_list",
    "file_read",
    "read_image",
    "file_write",
    "file_edit",
    "memory_write",
    "memory_get",
    "open_url",
    "web_fetch",
    "web_search",
    "browser_use",
    "mcp_tools",
    "mcp_call",
    // 手机能力,与 PhoneTools.ets 的 NAMES 一致
    "device_info",
    "clipboard_write",
    "set_alarm",
    "set_reminder",
    "notify",
    "flashlight",
    "open_app_link",
    "dial",
    "location",
    "weather",
  ]
}

export function localToolSchema(): object[] {
  const str = (description: string) => ({ type: "string", description })
  const tool = (name: string, description: string, properties: Record<string, object>, required: string[]) => ({
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required },
    },
  })
  return [
    tool("file_list", "List files in the Harmony app sandbox workspace.", {
      tool_title: str("Short summary shown to the user"),
    }, ["tool_title"]),
    tool("file_read", "Read a text file from the Harmony app sandbox. Path is a file name, not a Linux path. Head pages that still have unread lines append next_offset.", {
      tool_title: str("Short summary shown to the user"),
      path: str("Sandbox file name, e.g. notes.md"),
      offset: { type: "integer", description: "1-based line number to start reading from (default: 1). Ignored when direction is tail." },
      lines: { type: "integer", description: "Maximum number of lines to return" },
      max_length: { type: "integer", description: "Maximum character length of returned content (default: 15000, hard cap 80000)" },
      direction: str("head (default) or tail"),
    }, ["tool_title", "path"]),
    tool("read_image", "Look at an image file from the sandbox (files the user attached, downloads). The image is returned to you.", {
      tool_title: str("Short summary shown to the user"),
      path: str("Sandbox file name"),
    }, ["tool_title", "path"]),
    tool("file_write", "Write a text file in the Harmony app sandbox. User must approve writes.", {
      tool_title: str("Short summary shown to the user"),
      path: str("Sandbox file name"),
      content: str("Full file text"),
    }, ["tool_title", "path", "content"]),
    tool("file_edit", "Replace the first occurrence of old text in a sandbox file.", {
      tool_title: str("Short summary shown to the user"),
      path: str("Sandbox file name"),
      old: str("Text to find"),
      new: str("Replacement"),
    }, ["tool_title", "path", "old", "new"]),
    tool("memory_write", "Append a memory entry to today's daily log.", {
      tool_title: str("Short summary shown to the user"),
      content: str("Concise markdown memory"),
    }, ["tool_title", "content"]),
    tool("memory_get", "Search persistent memories.", {
      tool_title: str("Short summary shown to the user"),
      scope: str("daily or all"),
      keywords: str("Space-separated keywords"),
    }, ["tool_title"]),
    tool("open_url", "Open an http(s) link in the in-app browser.", {
      tool_title: str("Short summary shown to the user"),
      url: str("https URL"),
    }, ["tool_title", "url"]),
    tool("web_fetch", "Download a public https page as text. No JavaScript.", {
      tool_title: str("Short summary shown to the user"),
      url: str("https URL"),
    }, ["tool_title", "url"]),
    tool("web_search", "Search the web (Bing, then DuckDuckGo) and get titles, links and snippets. Read a result with web_fetch.", {
      tool_title: str("Short summary shown to the user"),
      query: str("Search words"),
      count: { type: "integer", description: "How many results (default 8)" },
    }, ["tool_title", "query"]),
    tool("browser_use", "Open or manage up to 3 in-app browser tabs.", {
      tool_title: str("Short summary shown to the user"),
      action: str("navigate, new_tab, close_tab, list_tabs"),
      url: str("https URL"),
      tab_id: str("Tab id"),
    }, ["tool_title", "action"]),
    tool("mcp_tools", "List the tools of a configured MCP server with their input schemas.", {
      tool_title: str("Short summary shown to the user"),
      server: str("MCP server label"),
    }, ["tool_title", "server"]),
    tool("mcp_call", "Call a tool on a configured MCP server. Look up tool names and input schemas with mcp_tools first.", {
      tool_title: str("Short summary shown to the user"),
      server: str("MCP server label"),
      name: str("Tool name"),
      arguments: str("JSON object with the tool arguments"),
    }, ["tool_title", "server", "name"]),
  ]
}

export type MdBlock = {
  kind: string
  text: string
}

export function parseTableRows(raw: string): string[][] {
  const lines = raw.split("\n")
  const out: string[][] = []
  for (const line of lines) {
    const parts = line.split("|")
    const cells: string[] = []
    for (let i = 0; i < parts.length; i++) {
      if (i === 0 && parts[i].trim() === "") continue
      if (i === parts.length - 1 && parts[i].trim() === "") continue
      cells.push(parts[i].trim())
    }
    if (cells.length > 0) out.push(cells)
  }
  return out
}

export function splitMarkdown(raw: string): MdBlock[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n")
  const out: MdBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith("```")) {
      const buf: string[] = []
      i += 1
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      out.push({ kind: "code", text: buf.join("\n") })
      continue
    }
    if (line.startsWith("|") && line.indexOf("|", 1) > 0) {
      const rows: string[] = [line]
      i += 1
      while (i < lines.length && lines[i].startsWith("|")) {
        if (!/^\|\s*-+/.test(lines[i])) rows.push(lines[i])
        i += 1
      }
      out.push({ kind: "table", text: rows.join("\n") })
      continue
    }
    if (line.startsWith("### ")) {
      out.push({ kind: "h3", text: line.slice(4) })
    } else if (line.startsWith("## ")) {
      out.push({ kind: "h2", text: line.slice(3) })
    } else if (line.startsWith("# ")) {
      out.push({ kind: "h1", text: line.slice(2) })
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      out.push({ kind: "li", text: line.slice(2) })
    } else if (/^\d+\.\s/.test(line)) {
      out.push({ kind: "li", text: line.replace(/^\d+\.\s/, "") })
    } else {
      out.push({ kind: "p", text: line.replace(/\*\*(.*?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1") })
    }
    i += 1
  }
  return out.length > 0 ? out : [{ kind: "p", text: raw }]
}

export type FailoverSlot = {
  instanceId: string
  model: string
}

export function resolveFailoverQueue(
  activeId: string,
  instances: { id: string, label: string, model: string, enabled: boolean, type?: string }[],
  groupIds: string[],
): FailoverSlot[] {
  const out: FailoverSlot[] = []
  const seen = new Set<string>()
  const push = (instanceId: string, model: string) => {
    const key = `${instanceId}/${model}`
    if (seen.has(key) || !instanceId || !model) return
    seen.add(key)
    out.push({ instanceId, model })
  }
  // 组条目是 `${label}/${model}`。原来用 lastIndexOf("/") 反着切，遇到 OpenRouter 这种
  // 模型 id 自带斜杠的（anthropic/claude-3-opus）会切成 label="OpenRouter/anthropic"，
  // 匹配不到实例，条目被静默丢掉。改成按已知实例标签做前缀匹配。
  // 与 LocalProtocol.ets 的 resolveFailoverQueue 保持一致。
  for (const raw of groupIds) {
    if (!raw.includes("/")) continue
    const hit = instances.find((row) => {
      const tag = row.label || row.type || ""
      return row.enabled && tag.length > 0 && raw.startsWith(`${tag}/`)
    })
    if (hit) push(hit.id, raw.slice((hit.label || hit.type || "").length + 1))
  }
  if (out.length === 0) {
    const active = instances.find((row) => row.id === activeId && row.enabled) ??
      instances.find((row) => row.enabled)
    if (active) push(active.id, active.model)
  }
  return out
}

/**
 * 与 LocalProtocol.ets 的 shouldFailover 保持一致。
 *
 * 原来是 includes("rate")：任何含 generate / moderate / separate 的错误文案都会误判成限流。
 * 原来的 "http 4" 还覆盖了 400/404 —— 那是我们自己请求写错了，换一家一样错，
 * 只会把所有供应商刷一遍再报「供应商都试过了」，把真正的报错吞掉。
 */
export function shouldFailover(message: string): boolean {
  const text = message.toLowerCase()
  if (text.includes("http 400") || text.includes("http 404") || text.includes("http 422")) {
    return false
  }
  return text.includes("unauthorized") ||
    text.includes("http 4") ||
    text.includes("http 5") ||
    text.includes("overloaded") ||
    text.includes("rate limit") ||
    text.includes("rate_limit") ||
    text.includes("429") ||
    text.includes("timeout") ||
    text.includes("stream ended")
}

/** 与 LocalProtocol.ets 的 friendlyModelError 保持一致:内部判断用原文,显示时换成中文。 */
export function friendlyModelError(message: string): string {
  const text = message.toLowerCase()
  if (text.includes("unauthorized") || text.includes("http 401") || text.includes("http 403")) {
    return "AI 服务商拒绝了钥匙:到「AI 服务商」里检查钥匙或重新登录"
  }
  if (text.includes("429") || text.includes("rate limit") || text.includes("rate_limit")) {
    return "AI 服务商说请求太频繁,稍后再试"
  }
  if (text.includes("overloaded")) return "AI 服务商现在太忙,稍后再试或换一个模型"
  if (text.includes("stream ended")) return "回答中途断了,点「重新生成」再试"
  if (text.includes("http 5")) return "AI 服务商那边出错了,稍后再试"
  if (text.includes("timeout")) return "等 AI 服务商回话超时了,检查网络后再试"
  return message
}

/**
 * `[prompt, completion]`。
 *
 * 返回元组而不是对象,是为了跟真正上线的 `LocalProtocol.ets` 的
 * `usageFromJson(json: object): number[]` 一字不差 —— 这个目录是给 Node 单测用的
 * 镜像,ArkTS 那边 import 不了它,两边只能靠人手对齐。之前镜像返回
 * `{prompt, completion}`,单测测的是一个线上根本不存在的形状。
 */
export const FILE_READ_HARD_CAP = 80_000
export const FILE_READ_DEFAULT_MAX = 15_000

export type FileReadPage = {
  showStart: number
  showEnd: number
  totalLines: number
  content: string
  truncated: boolean
  nextOffset: number | null
}

/** Same pagination contract as Android FileReadPaging / iOS FileReadPaging. */
export function fileReadPage(
  allLines: string[],
  offset: number,
  requestedLines: number | null,
  maxLength: number,
  direction: string,
): FileReadPage {
  const total = allLines.length
  const cap = Math.max(1, Math.min(maxLength, FILE_READ_HARD_CAP))
  if (total === 0) {
    return { showStart: 1, showEnd: 0, totalLines: 0, content: "", truncated: false, nextOffset: null }
  }
  const isTail = direction.toLowerCase() === "tail"
  let selected: string[]
  let showStart: number
  if (isTail) {
    const count = requestedLines ?? total
    const start = Math.max(0, total - count)
    selected = allLines.slice(start, total)
    showStart = start + 1
  } else {
    const start = Math.min(Math.max(0, Math.max(offset, 1) - 1), total)
    const end = requestedLines != null ? Math.min(start + Math.max(requestedLines, 0), total) : total
    selected = allLines.slice(start, end)
    showStart = selected.length === 0 ? Math.max(offset, 1) : start + 1
  }
  return clipFileRead(selected, showStart, total, cap, isTail)
}

function clipFileRead(
  selected: string[],
  showStart: number,
  total: number,
  cap: number,
  isTail: boolean,
): FileReadPage {
  if (selected.length === 0) {
    return { showStart, showEnd: showStart - 1, totalLines: total, content: "", truncated: false, nextOffset: null }
  }
  const joined = selected.join("\n")
  if (joined.length <= cap) {
    const showEnd = showStart + selected.length - 1
    const next = !isTail && showEnd < total ? showEnd + 1 : null
    return { showStart, showEnd, totalLines: total, content: joined, truncated: false, nextOffset: next }
  }
  let used = 0
  let complete = 0
  for (const line of selected) {
    const extra = complete === 0 ? 0 : 1
    if (used + extra + line.length > cap) break
    used += extra + line.length
    complete++
  }
  if (complete === 0) {
    return {
      showStart,
      showEnd: showStart,
      totalLines: total,
      content: selected[0].slice(0, cap),
      truncated: true,
      nextOffset: isTail ? null : showStart + 1,
    }
  }
  const showEnd = showStart + complete - 1
  return {
    showStart,
    showEnd,
    totalLines: total,
    content: selected.slice(0, complete).join("\n"),
    truncated: true,
    nextOffset: !isTail && showEnd < total ? showEnd + 1 : null,
  }
}

export function formatFileReadOutput(path: string, size: number, page: FileReadPage): string {
  const range = page.totalLines === 0 || page.showEnd < page.showStart
    ? "showing 0-0 of 0"
    : `showing ${page.showStart}-${page.showEnd} of ${page.totalLines}`
  const trunc = page.truncated ? ` (truncated at ${FILE_READ_HARD_CAP} chars or requested max_length)` : ""
  const header = `[${path} | ${size} bytes | ${page.totalLines} lines | ${range}${trunc}]`
  const next = page.nextOffset != null ? `\nnext_offset: ${page.nextOffset}` : ""
  return `${header}\n${page.content}${next}`
}

export function usageFromJson(json: unknown): number[] {
  const obj = asRecord(json)
  if (!obj) return [0, 0]
  const usage = asRecord(obj.usage)
  if (usage) {
    const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0)
    const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0)
    if (prompt > 0 || completion > 0) return [prompt, completion]
  }
  const meta = asRecord(obj.usageMetadata)
  if (meta) {
    return [Number(meta.promptTokenCount ?? 0), Number(meta.candidatesTokenCount ?? 0)]
  }
  return [0, 0]
}

/** 与 LocalProtocol.ets 保持一致:定时提醒的时间、系统提示里的「现在」、天气摘要。 */
export type LocalDateTime = { year: number, month: number, day: number, hour: number, minute: number }

export function parseReminderTime(raw: string, now: number): LocalDateTime | null {
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(raw)
  if (!m) return null
  const out = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) }
  if (out.month < 1 || out.month > 12 || out.day < 1 || out.day > 31 || out.hour > 23 || out.minute > 59) return null
  const when = new Date(out.year, out.month - 1, out.day, out.hour, out.minute, 0, 0).getTime()
  return when > now ? out : null
}

export function nowLine(now: number): string {
  const d = new Date(now)
  const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()]
  const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`)
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? "+" : "-"
  const zone = `UTC${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  return `现在是 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 周${week} ${pad(d.getHours())}:${pad(d.getMinutes())}(${zone})。`
}

export function wmoText(code: number): string {
  if (code === 0) return "晴"
  if (code === 1) return "大致晴"
  if (code === 2) return "局部多云"
  if (code === 3) return "阴"
  if (code === 45 || code === 48) return "雾"
  if (code >= 51 && code <= 55) return "毛毛雨"
  if (code === 56 || code === 57) return "冻毛毛雨"
  if (code === 61) return "小雨"
  if (code === 63) return "中雨"
  if (code === 65) return "大雨"
  if (code === 66 || code === 67) return "冻雨"
  if (code === 71) return "小雪"
  if (code === 73) return "中雪"
  if (code === 75) return "大雪"
  if (code === 77) return "雪粒"
  if (code >= 80 && code <= 82) return "阵雨"
  if (code === 85 || code === 86) return "阵雪"
  if (code === 95) return "雷阵雨"
  if (code === 96 || code === 99) return "雷阵雨伴冰雹"
  return `天气代码 ${code}`
}

export function weatherSummary(json: any, place: string): string {
  const cur = json?.current
  const daily = json?.daily
  const lines: string[] = []
  if (cur) {
    const temp = Math.round(Number(cur.temperature_2m ?? 0))
    const feels = Math.round(Number(cur.apparent_temperature ?? temp))
    const hum = Math.round(Number(cur.relative_humidity_2m ?? 0))
    const wind = Math.round(Number(cur.wind_speed_10m ?? 0))
    lines.push(`${place} · 现在 ${temp}°C(体感 ${feels}°C),${wmoText(Number(cur.weather_code ?? -1))},湿度 ${hum}%,风 ${wind} km/h`)
  }
  if (daily) {
    const days: string[] = daily.time ?? []
    const codes: number[] = daily.weather_code ?? []
    const highs: number[] = daily.temperature_2m_max ?? []
    const lows: number[] = daily.temperature_2m_min ?? []
    const rain: number[] = daily.precipitation_probability_max ?? []
    const names = ["今天", "明天", "后天"]
    for (let i = 0; i < Math.min(3, days.length); i++) {
      const chance = rain.length > i ? `,降水概率 ${Math.round(rain[i])}%` : ""
      lines.push(`${names[i]}(${days[i]}) ${wmoText(codes[i] ?? -1)},${Math.round(lows[i] ?? 0)}–${Math.round(highs[i] ?? 0)}°C${chance}`)
    }
  }
  return lines.length > 0 ? lines.join("\n") : "天气服务没有返回数据"
}

/** 与 LocalProtocol.ets 保持一致:环境变量只列名字,执行时替换 $$名字。 */
export function envPromptBlock(names: string[]): string {
  if (names.length === 0) return ""
  return `环境变量(只给名字,值留在本机):${names.join("、")}。工具参数里要用时写 $$名字,执行时换成真实值;不要让用户把值念出来。`
}

export function expandEnvPlaceholders(args: string, values: Map<string, string>): string {
  if (values.size === 0 || args.indexOf("$$") < 0) return args
  return args.replace(/\$\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole: string, name: string): string => {
    const value = values.get(name)
    if (value === undefined) return whole
    const quoted = JSON.stringify(value)
    return quoted.substring(1, quoted.length - 1)
  })
}

/** 与 LocalProtocol.ets 保持一致:对话档案,和 sessionArchiveFromJson 互为逆操作。 */
export function sessionArchiveJson(title: string, messages: { role: string, text: string }[]): string {
  const rows: string[] = []
  for (const line of messages) {
    if (line.role !== "user" && line.role !== "assistant" && line.role !== "system") continue
    const text = line.text.length > 0 ? line.text : "[图片]"
    rows.push(`{"role":${JSON.stringify(line.role)},"content":${JSON.stringify(text)}}`)
  }
  return `{"title":${JSON.stringify(title)},"messages":[${rows.join(",")}]}`
}

/** 与 LocalProtocol.ets 保持一致:和安卓 HeadlessChatRunner.nextDelta 同一个规则。 */
export function nextDelta(sent: string, text: string): string {
  if (text.startsWith(sent)) return text.substring(sent.length)
  if (sent.startsWith(text)) return ""
  let common = 0
  while (common < sent.length && common < text.length && sent.charAt(common) === text.charAt(common)) common++
  return text.substring(common)
}

export type HistoryTurn = { role: string, content: string, imageB64: string, imageMime: string }
export const HISTORY_CHAR_BUDGET = 60000
export const HISTORY_IMAGE_KEEP = 2
const IMAGE_CHAR_COST = 1500

export function trimHistory(turns: HistoryTurn[], maxChars: number): HistoryTurn[] {
  const out: HistoryTurn[] = []
  let used = 0
  let images = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = { role: turns[i].role, content: turns[i].content, imageB64: "", imageMime: "image/jpeg" }
    if (turns[i].imageB64.length > 0) {
      if (images < HISTORY_IMAGE_KEEP) {
        turn.imageB64 = turns[i].imageB64
        turn.imageMime = turns[i].imageMime
        images += 1
      } else {
        turn.content = `${turn.content}\n(这里原来有一张图片,太早了没再发)`
      }
    }
    const cost = turn.content.length + (turn.imageB64.length > 0 ? IMAGE_CHAR_COST : 0)
    if (out.length > 0 && used + cost > maxChars) break
    used += cost
    out.unshift(turn)
  }
  while (out.length > 1 && out[0].role !== "user") out.shift()
  if (out.length < turns.length && out.length > 0) {
    out[0].content = `(更早的对话太长,已省略)\n\n${out[0].content}`
  }
  return out
}
