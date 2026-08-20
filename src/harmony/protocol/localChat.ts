export type LocalChatMessage = {
  role: string
  text: string
  imageB64?: string
  imageMime?: string
  imagePath?: string
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
      throw new Error("供应商根不合法")
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
    throw new Error("供应商根只有 https，或本机/局域网 http")
  }
  throw new Error("供应商根必须是 https://")
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
    messages.push({
      role,
      text: text.trim() || (imageB64 || imagePath ? "看这张图" : ""),
      imageB64,
      imageMime,
      imagePath,
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

export function toolArg(raw: string, key: string): string {
  try {
    const obj = asRecord(JSON.parse(raw))
    if (!obj || obj[key] === undefined || obj[key] === null) return ""
    return `${obj[key]}`
  } catch {
    return ""
  }
}

export function localToolNames(): string[] {
  return [
    "file_list",
    "file_read",
    "file_write",
    "file_edit",
    "memory_write",
    "memory_get",
    "open_url",
    "web_fetch",
    "browser_use",
    "mcp_call",
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
    tool("file_read", "Read a text file from the Harmony app sandbox. Path is a file name, not a Linux path.", {
      tool_title: str("Short summary shown to the user"),
      path: str("Sandbox file name, e.g. notes.md"),
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
    tool("browser_use", "Open or manage up to 3 in-app browser tabs.", {
      tool_title: str("Short summary shown to the user"),
      action: str("navigate, new_tab, close_tab, list_tabs"),
      url: str("https URL"),
      tab_id: str("Tab id"),
    }, ["tool_title", "action"]),
    tool("mcp_call", "Call a configured HTTP MCP tool.", {
      tool_title: str("Short summary shown to the user"),
      server: str("MCP server label"),
      name: str("Tool name"),
      arguments: str("JSON object"),
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
    text.includes("timeout")
}

/**
 * `[prompt, completion]`。
 *
 * 返回元组而不是对象,是为了跟真正上线的 `LocalProtocol.ets` 的
 * `usageFromJson(json: object): number[]` 一字不差 —— 这个目录是给 Node 单测用的
 * 镜像,ArkTS 那边 import 不了它,两边只能靠人手对齐。之前镜像返回
 * `{prompt, completion}`,单测测的是一个线上根本不存在的形状。
 */
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
