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
