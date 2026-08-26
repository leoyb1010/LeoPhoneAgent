import { normalizeApiRoot, sanitizeMachine } from "./relayMachines.ts"

export type PairPayload = {
  apiRoot: string
  machine: string
  join?: string
  exp?: number
}

export const PAIR_PREFIX = "leoagent-body:v1|"
export const PAIR_PREFIX_V2 = "leoagent-body:v2|"

export function encodePair(apiRoot: string, machine: string, join?: string, exp?: number): string {
  const payload: PairPayload = {
    apiRoot: normalizeApiRoot(apiRoot),
    machine: machine.trim(),
  }
  const token = join?.trim()
  if (token) {
    payload.join = token
    if (typeof exp === "number" && Number.isFinite(exp)) payload.exp = exp
    return PAIR_PREFIX_V2 + JSON.stringify(payload)
  }
  return PAIR_PREFIX + JSON.stringify(payload)
}

export function decodePair(raw: string): PairPayload | null {
  const text = raw.trim()
  let jsonText = ""
  if (text.startsWith(PAIR_PREFIX_V2)) {
    jsonText = text.slice(PAIR_PREFIX_V2.length)
  } else if (text.startsWith(PAIR_PREFIX)) {
    jsonText = text.slice(PAIR_PREFIX.length)
  } else if (text.startsWith("{")) {
    jsonText = text
  } else {
    return null
  }
  try {
    const obj = JSON.parse(jsonText) as unknown
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null
    const record = obj as Record<string, unknown>
    const apiRoot = typeof record.apiRoot === "string" ? normalizeApiRoot(record.apiRoot) : ""
    const machine = typeof record.machine === "string" ? sanitizeMachine(record.machine) : null
    if (!apiRoot || !machine) return null
    if (!apiRoot.toLowerCase().startsWith("https://")) return null
    const join = typeof record.join === "string" ? record.join.trim() : ""
    const exp = typeof record.exp === "number" && Number.isFinite(record.exp) ? record.exp : undefined
    return join ? { apiRoot, machine, join, exp } : { apiRoot, machine }
  } catch {
    return null
  }
}
