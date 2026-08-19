export type HarnessKind = {
  key: string
  name: string
}

export type HarnessSessionSummary = {
  id: string
  harness: string
  name: string
  cwd: string
  status: string
  seq: number
  waitingForApproval: boolean
  pendingApprovalId: string | null
  pendingApprovalCommand: string | null
}

export type EngineChunk =
  | { kind: "delta"; text: string }
  | { kind: "completed"; output: string }
  | { kind: "failed"; message: string }

export type HarnessEvent = {
  seq: number
  event: string
  text?: string
  delta?: string
  output?: string
  message?: string
  approval_id?: string
  command?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function capabilitiesFromJson(json: unknown): HarnessKind[] {
  const obj = asRecord(json)
  if (!obj || !Array.isArray(obj.harnesses)) return []
  const out: HarnessKind[] = []
  for (const row of obj.harnesses) {
    const item = asRecord(row)
    if (!item || typeof item.key !== "string" || !item.key) continue
    out.push({
      key: item.key,
      name: typeof item.name === "string" && item.name ? item.name : item.key,
    })
  }
  return out
}

export function sessionSummaryFromJson(json: unknown): HarnessSessionSummary | null {
  const item = asRecord(json)
  if (!item || typeof item.session_id !== "string" || !item.session_id) return null
  const pendingRows = Array.isArray(item.pending_approvals) ? item.pending_approvals : []
  const pending = pendingRows.length > 0 ? asRecord(pendingRows[0]) : null
  return {
    id: item.session_id,
    harness: typeof item.harness === "string" ? item.harness : "",
    name: typeof item.name === "string" ? item.name : "",
    cwd: typeof item.cwd === "string" ? item.cwd : "",
    status: typeof item.status === "string" ? item.status : "unknown",
    seq: typeof item.seq === "number" ? item.seq : 0,
    waitingForApproval: item.waiting_for_approval === true,
    pendingApprovalId: pending && typeof pending.approval_id === "string" ? pending.approval_id : null,
    pendingApprovalCommand: pending && typeof pending.command === "string" ? pending.command : null,
  }
}
