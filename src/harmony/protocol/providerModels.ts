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
