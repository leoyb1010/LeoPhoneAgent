export type RelayDiscoveredMachine = {
  name: string
  online: boolean
  platform: string | null
  server: string | null
  version: string | null
}

export const DEFAULT_API_ROOT =
  "https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api"

export function normalizeApiRoot(raw: string): string {
  return raw.trim().replace(/\/+$/, "")
}

export function sanitizeKey(raw: string): string {
  return raw.trim().replace(/%+$/g, "").replace(/[\r\n]+/g, "")
}

export function requireHttpsRoot(raw: string): string {
  const root = normalizeApiRoot(raw)
  if (!root.toLowerCase().startsWith("https://")) {
    throw new Error("中继根必须是 https://")
  }
  const rest = root.slice("https://".length)
  if (!rest || rest.includes("@") || rest.includes(" ") || rest.includes("#")) {
    throw new Error("中继根不合法")
  }
  return root
}

export type SavedHostState = {
  name: string
  online: boolean
}

export function applyDiscovery(existing: SavedHostState[], live: RelayDiscoveredMachine[]): SavedHostState[] {
  const next: SavedHostState[] = existing.map((host) => ({ name: host.name, online: false }))
  for (const incoming of live) {
    const found = next.find((host) => host.name === incoming.name)
    if (found) {
      found.online = incoming.online
    } else {
      next.push({ name: incoming.name, online: incoming.online })
    }
  }
  return next
}

export function sameApiRoot(lhs: string, rhs: string): boolean {
  return normalizeApiRoot(lhs).toLowerCase() === normalizeApiRoot(rhs).toLowerCase()
}

export function harnessURL(apiRoot: string, machine: string): string {
  return normalizeApiRoot(apiRoot) + "/m/" + machine
}

export function apiRootFromHarnessURL(raw: string | null | undefined): string | null {
  if (!raw) return null
  const index = raw.toLowerCase().lastIndexOf("/m/")
  if (index < 0) return null
  const root = normalizeApiRoot(raw.slice(0, index))
  if (!root.toLowerCase().startsWith("https://")) return null
  return root
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function parseMachines(json: unknown): RelayDiscoveredMachine[] {
  const obj = asRecord(json)
  if (!obj) return []
  const rows = obj.machines
  if (!Array.isArray(rows)) return []
  const out: RelayDiscoveredMachine[] = []
  for (const row of rows) {
    const item = asRecord(row)
    if (!item) continue
    const name = typeof item.name === "string" ? sanitizeMachine(item.name) : null
    if (!name) continue
    out.push({
      name,
      online: typeof item.online === "boolean" ? item.online : true,
      platform: typeof item.platform === "string" ? item.platform : null,
      server: typeof item.server === "string" ? item.server : null,
      version: typeof item.version === "string" ? item.version : null,
    })
  }
  return out
}

export function isHarmonyBody(machine: RelayDiscoveredMachine): boolean {
  return machine.platform === "harmony"
}

export function isAndroidBody(machine: RelayDiscoveredMachine): boolean {
  if (isHarmonyBody(machine)) return false
  return machine.platform === "android" || machine.server === "minis"
}

export function sanitizeMachine(raw: string): string | null {
  const name = raw.trim()
  if (!name || name.length > 80) return null
  if (/[/\\?#%]/.test(name) || name.includes("..")) return null
  return name
}

export function displayName(machine: string): string {
  switch (machine) {
    case "LeoyuandeMacBook-Pro-2":
      return "MacBook Pro"
    case "LeodeMac-mini-2":
      return "Mac mini · cortex"
    case "LeoMac-Studio-2":
      return "Mac Studio"
    default:
      return machine
  }
}
