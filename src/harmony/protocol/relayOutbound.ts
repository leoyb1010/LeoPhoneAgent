import { normalizeApiRoot } from "./relayMachines.ts"

export type RegisterFrame = {
  type: "register"
  name: string
  key: string
  info: {
    platform: "harmony"
    server: "minis"
    version: string
  }
}

export function agentWsUrl(apiBase: string): string {
  let url = normalizeApiRoot(apiBase)
  url = url.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://")
  url = url.replace(/\/relay\/api$/i, "/relay/agent")
  if (!/\/relay\/agent$/i.test(url)) {
    url = /\/relay$/i.test(url) ? url + "/agent" : url + "/relay/agent"
  }
  return url
}

export function registerFrame(name: string, key: string, version: string): RegisterFrame {
  return {
    type: "register",
    name,
    key,
    info: {
      platform: "harmony",
      server: "minis",
      version,
    },
  }
}

export function parseSseData(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith("data:")) return null
  const payload = trimmed.slice("data:".length).trim()
  return payload.length > 0 ? payload : null
}

export type AgentHttpFrame = {
  type: string
  id: string
  method: string
  path: string
  body: unknown
}

export function parseAgentFrame(raw: string): AgentHttpFrame | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    if (!obj || typeof obj.type !== "string") return null
    return {
      type: obj.type,
      id: obj.id === undefined || obj.id === null ? "" : `${obj.id}`,
      method: typeof obj.method === "string" ? obj.method : "GET",
      path: typeof obj.path === "string" ? obj.path : "/",
      body: obj.body ?? null,
    }
  } catch {
    return null
  }
}

export function respFrame(id: string, status: number, body: unknown): object {
  return { type: "resp", id, status, body }
}

export function streamDataFrame(id: string, data: string): object {
  return { type: "stream_data", id, data }
}

export function streamCloseFrame(id: string): object {
  return { type: "stream_close", id }
}

export function eventFrame(machine: string, event: unknown): object {
  return { type: "event", machine, event }
}
