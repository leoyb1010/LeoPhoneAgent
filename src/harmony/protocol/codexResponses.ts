export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses"
export const CODEX_CLIENT_VERSION = "0.144.1"

export function usesCodexResponses(type: string, credential: string, root: string): boolean {
  if (type !== "openAI" || credential !== "oauth") return false
  const host = rootHost(root)
  return host.length === 0 || host === "api.openai.com" || host === "chatgpt.com"
}

export function rootHost(root: string): string {
  const raw = root.trim().toLowerCase()
  const noScheme = raw.replace(/^https?:\/\//, "")
  return (noScheme.split("/")[0] ?? "").split(":")[0] ?? ""
}

export function accountIdFromIdToken(token: string): string {
  const parts = token.split(".")
  if (parts.length < 2) return ""
  try {
    const json = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>
    return typeof json.chatgpt_account_id === "string" ? json.chatgpt_account_id : ""
  } catch {
    return ""
  }
}

export function splitResponsesIds(combined: string): { callId: string, fcId: string } {
  const sep = combined.indexOf("|")
  if (sep < 0) return { callId: combined, fcId: "" }
  return { callId: combined.substring(0, sep), fcId: combined.substring(sep + 1) }
}

export function combineResponsesIds(callId: string, fcId: string): string {
  return fcId.length > 0 ? `${callId}|${fcId}` : callId
}

export function capResponsesId(id: string): string {
  return id.length <= 64 ? id : id.substring(0, 64)
}

export type LoopLike = {
  role: string
  content: string
  toolCallId?: string
  calls?: Array<{ id: string, name: string, args: string }>
  imageB64?: string
  imageMime?: string
}

export function responsesInputJson(turns: LoopLike[]): string {
  const rows: string[] = []
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    if (turn.role === "tool") {
      const ids = splitResponsesIds(turn.toolCallId ?? "")
      rows.push(
        `{"type":"function_call_output","call_id":${JSON.stringify(capResponsesId(ids.callId))},"output":${JSON.stringify(turn.content)}}`,
      )
      continue
    }
    const calls = turn.calls ?? []
    if (calls.length > 0) {
      if (turn.content.length > 0) {
        rows.push(`{"role":"assistant","content":${JSON.stringify(turn.content)}}`)
      }
      for (let j = 0; j < calls.length; j++) {
        const ids = splitResponsesIds(calls[j].id)
        const callId = capResponsesId(ids.callId.length > 0 ? ids.callId : `call_${j}`)
        const fcId = capResponsesId(ids.fcId.length > 0 ? ids.fcId : `fc_syn_${callId.slice(-24)}`)
        rows.push(
          `{"type":"function_call","id":${JSON.stringify(fcId)},"call_id":${JSON.stringify(callId)},"name":${JSON.stringify(calls[j].name)},"arguments":${JSON.stringify(calls[j].args)}}`,
        )
      }
      continue
    }
    if ((turn.imageB64 ?? "").length > 0) {
      const mime = turn.imageMime && turn.imageMime.length > 0 ? turn.imageMime : "image/jpeg"
      rows.push(
        `{"role":${JSON.stringify(turn.role)},"content":[{"type":"input_text","text":${JSON.stringify(turn.content)}},{"type":"input_image","image_url":"data:${mime};base64,${turn.imageB64}"}]}`,
      )
      continue
    }
    rows.push(`{"role":${JSON.stringify(turn.role)},"content":${JSON.stringify(turn.content)}}`)
  }
  return `[${rows.join(",")}]`
}

export function responsesToolSchemaJson(chatToolsJson: string): string {
  const rows = JSON.parse(chatToolsJson) as Array<Record<string, unknown>>
  const out: string[] = []
  for (let i = 0; i < rows.length; i++) {
    const fn = rows[i].function as Record<string, unknown> | undefined
    if (!fn) continue
    out.push(
      `{"type":"function","name":${JSON.stringify(fn.name)},"description":${JSON.stringify(fn.description)},"parameters":${JSON.stringify(fn.parameters)}}`,
    )
  }
  return `[${out.join(",")}]`
}

export function responsesBodyJson(
  model: string,
  systemPrompt: string,
  turns: LoopLike[],
  toolsJson: string,
  thinking: string,
): string {
  const effort = thinking.trim().length > 0 ? thinking.trim() : "low"
  const cache = firstUserText(turns)
  return `{"model":${JSON.stringify(model)},"stream":true,"store":false,"parallel_tool_calls":true,"prompt_cache_key":${JSON.stringify(cache)},"include":["reasoning.encrypted_content"],"reasoning":{"effort":${JSON.stringify(effort)},"summary":"auto"},"instructions":${JSON.stringify(systemPrompt)},"tools":${toolsJson},"tool_choice":"auto","input":${responsesInputJson(turns)}}`
}

export function firstUserText(turns: LoopLike[]): string {
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].role === "user" && turns[i].content.trim().length > 0) {
      return turns[i].content.trim().slice(0, 80)
    }
  }
  return "default"
}

export function responsesDeltaFromJson(json: unknown): string {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return ""
  const obj = json as Record<string, unknown>
  if (obj.type === "response.output_text.delta" && typeof obj.delta === "string") {
    return obj.delta
  }
  return ""
}

export function responsesErrorFromJson(json: unknown): string {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return ""
  const obj = json as Record<string, unknown>
  if (obj.type === "response.failed") {
    const resp = obj.response as Record<string, unknown> | undefined
    const err = resp?.error as Record<string, unknown> | undefined
    const message = typeof err?.message === "string" ? err.message : "response.failed"
    return message
  }
  if (obj.type === "error" && typeof obj.message === "string") return obj.message
  return ""
}

export type ToolLike = { id: string, name: string, args: string }

export function applyResponsesToolDelta(acc: ToolLike[], json: unknown): ToolLike[] {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return acc
  const obj = json as Record<string, unknown>
  const type = `${obj.type ?? ""}`
  const next = acc.map((row) => ({ id: row.id, name: row.name, args: row.args }))
  if (type === "response.output_item.added") {
    const item = obj.item as Record<string, unknown> | undefined
    if (item && item.type === "function_call") {
      const itemId = `${item.id ?? ""}`
      const callId = `${item.call_id ?? ""}`
      const name = `${item.name ?? ""}`
      if (itemId && callId && name) {
        next.push({ id: combineResponsesIds(callId, itemId), name, args: `${item.arguments ?? ""}` })
      }
    }
    return next
  }
  if (type === "response.function_call_arguments.delta") {
    const itemId = `${obj.item_id ?? ""}`
    const delta = `${obj.delta ?? ""}`
    for (let i = 0; i < next.length; i++) {
      if (next[i].id.endsWith(`|${itemId}`) || next[i].id === itemId) {
        next[i].args += delta
      }
    }
    return next
  }
  if (type === "response.output_item.done") {
    const item = obj.item as Record<string, unknown> | undefined
    if (item && item.type === "function_call") {
      const itemId = `${item.id ?? ""}`
      const args = `${item.arguments ?? ""}`
      for (let i = 0; i < next.length; i++) {
        if (next[i].id.endsWith(`|${itemId}`) || next[i].id === itemId) {
          if (args.length > 0) next[i].args = args
        }
      }
    }
  }
  return next
}
