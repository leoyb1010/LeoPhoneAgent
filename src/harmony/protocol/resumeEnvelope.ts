/** Shared resume watermark. Clients never decrement lastSeq. */

export type ResumeStatus = "ok" | "gap"

export type ResumeEnvelope = {
  type: "resume"
  status: ResumeStatus
  after: number
  min_after: number
}

export function resumeEnvelope(after: number, minAfter = 0): ResumeEnvelope {
  const safeAfter = Number.isFinite(after) ? Math.max(0, Math.trunc(after)) : 0
  const safeMin = Number.isFinite(minAfter) ? Math.max(0, Math.trunc(minAfter)) : 0
  if (safeAfter < safeMin) {
    return { type: "resume", status: "gap", after: safeAfter, min_after: safeMin }
  }
  return { type: "resume", status: "ok", after: safeAfter, min_after: safeMin }
}

export function parseResumeEnvelope(raw: unknown): ResumeEnvelope | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const kind = record.type === "resume" || record.event === "resume"
  if (!kind) return null
  const status = record.status === "gap" ? "gap" : record.status === "ok" ? "ok" : null
  if (!status) return null
  const after = Number(record.after ?? 0)
  const minAfter = Number(record.min_after ?? 0)
  if (!Number.isFinite(after) || !Number.isFinite(minAfter)) return null
  return resumeEnvelope(after, minAfter)
}

/** Apply a newly observed seq. Duplicates and rewinds are ignored. */
export function applySeq(lastSeq: number, incoming: number): number {
  if (!Number.isFinite(incoming) || incoming <= 0) return lastSeq
  return incoming > lastSeq ? incoming : lastSeq
}

/** Gap jumps forward to min_after. Never goes backwards. */
export function nextAfter(lastSeq: number, envelope: ResumeEnvelope): number {
  if (envelope.status === "gap") return Math.max(lastSeq, envelope.min_after)
  return lastSeq
}
