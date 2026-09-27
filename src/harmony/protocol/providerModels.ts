export function skipUpstreamModels(type: string, credential: string): boolean {
  return type === "openAI" && credential === "oauth"
}

export function modelsAuthHeaders(type: string, key: string): Record<string, string> {
  if (type === "gemini") {
    return {
      "x-goog-api-key": key,
      "Content-Type": "application/json",
    }
  }
  if (type === "anthropic") {
    return {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    }
  }
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  }
}

export function modelsListUrl(root: string, type: string, key: string): string {
  const base = root.replace(/\/+$/, "")
  if (type === "gemini") {
    const join = base.indexOf("?") >= 0 ? "&" : "?"
    return `${base}/models${join}key=${encodeURIComponent(key)}`
  }
  return `${base}/models`
}

export function modelIdsFromListJson(json: unknown): string[] {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return []
  const obj = json as Record<string, unknown>
  const ids: string[] = []
  const data = obj.data
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === "object") {
        const id = `${(item as Record<string, unknown>).id ?? ""}`.trim()
        if (id) ids.push(id)
      }
    }
  }
  const models = obj.models
  if (Array.isArray(models)) {
    for (const item of models) {
      if (item && typeof item === "object") {
        const name = `${(item as Record<string, unknown>).name ?? (item as Record<string, unknown>).id ?? ""}`.trim()
        if (name) ids.push(name.replace(/^models\//, ""))
      }
    }
  }
  return uniqueIds(ids)
}

export function modelsDevProviderKey(type: string): string {
  if (type === "openAI") return "openai"
  if (type === "anthropic") return "anthropic"
  if (type === "gemini") return "google"
  if (type === "xAI") return "xai"
  if (type === "kimiCode") return "moonshotai"
  if (type === "openRouter") return "openrouter"
  return ""
}

export const MODELS_DEV_URL = "https://models.dev/api.json"

export function idsFromModelsDevJson(json: unknown, providerKey: string): string[] {
  if (!providerKey || json === null || typeof json !== "object" || Array.isArray(json)) return []
  const root = json as Record<string, unknown>
  const provider = root[providerKey]
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return []
  const models = (provider as Record<string, unknown>).models
  if (!models || typeof models !== "object" || Array.isArray(models)) return []
  return uniqueIds(Object.keys(models as Record<string, unknown>))
}

export function fallbackModelIds(builtIn: string[], remote: string[]): string[] {
  if (remote.length > 0) return remote
  return builtIn.slice()
}

function uniqueIds(ids: string[]): string[] {
  const seen: string[] = []
  for (const id of ids) {
    if (seen.indexOf(id) < 0) seen.push(id)
  }
  return seen
}

export const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models"

/** 与 ProviderModels.ets 保持一致:Codex 模型目录 → 可列出的 slug,按 priority 排。 */
export function codexCatalogIds(json: any): string[] {
  const rows = json?.models
  if (!Array.isArray(rows)) return []
  const listed = rows.filter((row: any) => `${row?.visibility ?? "list"}` === "list" && `${row?.slug ?? ""}`.length > 0)
  listed.sort((a: any, b: any) => Number(a.priority ?? Number.MAX_SAFE_INTEGER) - Number(b.priority ?? Number.MAX_SAFE_INTEGER))
  return [...new Set(listed.map((row: any) => `${row.slug}`))]
}

// OpenCode Go 的目录里混着走 Responses / Anthropic Messages 的模型;本端只会 chat completions,
// 列出来一选就 4xx,所以拉回来的目录按协议筛一遍。筛完为空就原样返回,不把列表清空。
// 按 https://opencode.ai/docs/go/ 的端点表:GPT / Grok / Muse Spark 走 /v1/responses,
// MiniMax 和 Qwen 全部走 /v1/messages。和 iOS OpenCodeGoWireProtocol、ProviderModels.ets 保持一致。
const OPENCODE_GO_NON_CHAT_PREFIXES = ["gpt-", "grok-", "muse-spark-", "minimax-", "qwen"]
// /models 里还挂着、一调用就回 "Model is unavailable" 的下线模型(2026-09-27 实测),不给选。
const OPENCODE_GO_RETIRED = ["kimi-k2.5", "glm-5", "qwen3.5-plus", "mimo-v2-pro", "mimo-v2-omni", "hy3-preview", "grok-4.5"]

export function chatModelsFor(type: string, ids: string[]): string[] {
  if (type !== "openCodeGo") return ids
  const kept = ids.filter((id) => {
    const bare = id.toLowerCase().split("/").pop() ?? ""
    return !OPENCODE_GO_RETIRED.includes(bare) &&
      !OPENCODE_GO_NON_CHAT_PREFIXES.some((prefix) => bare.startsWith(prefix))
  })
  return kept.length > 0 ? kept : ids
}
