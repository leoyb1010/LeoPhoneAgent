import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';

export const WINDOW_SNAPSHOT_FRESH_MS = 3_000;
const MAX_WINDOW_SNAPSHOTS = 512;

export type WindowRef = {
  machine: string;
  app: string;
  pid: number;
  windowId: string;
  title: string;
  bundleId?: string;
  processStartedAt?: number;
};
export type WindowElement = {
  id: string;
  path: number[];
  role: string;
  subrole?: string;
  identifier?: string;
  title?: string;
  value?: string;
  bounds: string;
  enabled: boolean;
  settableValue: boolean;
  actions: string[];
  redacted: boolean;
  focused?: boolean;
};
export type WindowImage = { mimeType: 'image/jpeg'; data: string; width: number; height: number; scaleX: number; scaleY: number; hash: string };
export type WindowPermissions = { accessibility: boolean; screenCapture: boolean; postEvents: boolean };
export type WindowObservation = Omit<WindowRef, 'machine'> & {
  frontmost: boolean;
  bounds: string;
  onScreen?: boolean;
  occluded?: boolean;
  minimized?: boolean;
  scale?: number;
  elements?: WindowElement[];
  elementsTruncated?: boolean;
  menus?: Array<{ path: string[]; enabled: boolean }>;
  image?: WindowImage;
  permissions?: WindowPermissions;
  stateHash?: string;
};
export type WindowSnapshot = {
  snapshotId: string;
  ref: WindowRef;
  frontmost: boolean;
  bounds: string;
  capturedAt: number;
  hash: string;
  observation?: WindowObservation;
};
export const WINDOW_NAMED_KEYS = ['return', 'escape', 'tab', 'space', 'up', 'down', 'left', 'right', 'delete'] as const;
export type WindowNamedKey = (typeof WINDOW_NAMED_KEYS)[number];
export type WindowActionKind = 'ax' | 'menu' | 'coord' | 'key';
export type WindowAction =
  | { name: 'focus' | 'minimize' }
  | { name: 'press'; elementId: string }
  | { name: 'setValue'; elementId: string; value: string }
  | { name: 'select'; path: string[] }
  | { name: 'click'; x: number; y: number; coordinateSpace: 'normalized-window' }
  | { name: 'scroll'; x: number; y: number; coordinateSpace: 'normalized-window'; dx?: number; dy?: number }
  | { name: 'drag'; x: number; y: number; x2: number; y2: number; coordinateSpace: 'normalized-window' }
  | { name: 'key'; key: WindowNamedKey };
export type WindowActionReceipt = {
  attempted: boolean;
  verified: boolean;
  verification: string;
  action: string;
  observedAt: number;
};
export type WindowFailureReason =
  | 'unknown-snapshot' | 'snapshot-expired' | 'background-blocked' | 'unsupported-action'
  | 'unsupported-platform' | 'helper-unavailable' | 'permission-denied' | 'window-gone'
  | 'window-changed' | 'target-ambiguous' | 'window-occluded' | 'invalid-request'
  | 'timeout' | 'cancelled' | 'verification-failed' | 'observation-unavailable'
  | 'execution-failed' | 'element-changed' | 'element-unavailable' | 'scene-changed';
export class WindowOperationError extends Error {
  constructor(readonly reason: WindowFailureReason, message: string, readonly receipt?: WindowActionReceipt) { super(message); }
}
export type WindowOperationOptions = { signal?: AbortSignal; timeoutMs?: number; capture?: boolean; elements?: boolean };
export type ExactWindowDriver = {
  observe: (ref: WindowRef, options?: WindowOperationOptions) => Promise<WindowObservation>;
  execute: (snapshot: WindowSnapshot, kind: WindowActionKind, action: WindowAction, options?: WindowOperationOptions) => Promise<{ observation: WindowObservation; receipt: WindowActionReceipt }>;
};
export type WindowActionResult =
  | { ok: true; snapshot: WindowSnapshot; receipt: WindowActionReceipt }
  | { ok: false; reason: WindowFailureReason; message: string; receipt?: WindowActionReceipt };

export function parseWindowAction(kind: string, value: unknown): WindowAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const action = value as Record<string, unknown>;
  const elementId = typeof action.elementId === 'string' && action.elementId.length <= 128 ? action.elementId : '';
  if (kind === 'ax') {
    if (action.name === 'focus' || action.name === 'minimize') return { name: action.name };
    if (action.name === 'press' && elementId) return { name: 'press', elementId };
    if (action.name === 'setValue' && elementId && typeof action.value === 'string' && action.value.length <= 4096) {
      return { name: 'setValue', elementId, value: action.value };
    }
  }
  if (kind === 'menu' && action.name === 'select' && Array.isArray(action.path)
    && action.path.length >= 2 && action.path.length <= 6
    && action.path.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 160)) {
    return { name: 'select', path: action.path as string[] };
  }
  if (kind === 'coord' && action.coordinateSpace === 'normalized-window') {
    const x = parseNormalizedUnit(action.x);
    const y = parseNormalizedUnit(action.y);
    if (action.name === 'click' && x !== null && y !== null) return { name: 'click', x, y, coordinateSpace: 'normalized-window' };
    if (action.name === 'scroll' && x !== null && y !== null) {
      const dx = action.dx === undefined ? undefined : parseScrollDelta(action.dx);
      const dy = action.dy === undefined ? undefined : parseScrollDelta(action.dy);
      if ((dx !== undefined && dx === null) || (dy !== undefined && dy === null)) return null;
      if (!dx && !dy) return null;
      return { name: 'scroll', x, y, coordinateSpace: 'normalized-window', ...(dx ? { dx } : {}), ...(dy ? { dy } : {}) };
    }
    const x2 = parseNormalizedUnit(action.x2);
    const y2 = parseNormalizedUnit(action.y2);
    if (action.name === 'drag' && x !== null && y !== null && x2 !== null && y2 !== null && (x !== x2 || y !== y2)) {
      return { name: 'drag', x, y, x2, y2, coordinateSpace: 'normalized-window' };
    }
  }
  const namedKey = parseWindowNamedKey(action.key);
  if (kind === 'key' && action.name === 'key' && namedKey) return { name: 'key', key: namedKey };
  return null;
}

export function parseNormalizedUnit(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
}

export function parseScrollDelta(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n !== 0 && Math.abs(n) <= 24 ? n : null;
}

export function parseWindowNamedKey(value: unknown): WindowNamedKey | null {
  return typeof value === 'string' && (WINDOW_NAMED_KEYS as readonly string[]).includes(value) ? value as WindowNamedKey : null;
}

export function parseNormalizedClickPoint(x: unknown, y: unknown): { x: number; y: number } | null {
  const action = parseWindowAction('coord', { name: 'click', x: parseLooseNumber(x), y: parseLooseNumber(y), coordinateSpace: 'normalized-window' });
  return action && action.name === 'click' ? { x: action.x, y: action.y } : null;
}

function parseLooseNumber(value: unknown): number {
  return typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
}

export function parseWindowScroll(x: unknown, y: unknown, dx: unknown, dy: unknown): { x: number; y: number; dx?: number; dy?: number } | null {
  const action = parseWindowAction('coord', { name: 'scroll', x: parseLooseNumber(x), y: parseLooseNumber(y), dx, dy, coordinateSpace: 'normalized-window' });
  return action && action.name === 'scroll' ? { x: action.x, y: action.y, ...(action.dx ? { dx: action.dx } : {}), ...(action.dy ? { dy: action.dy } : {}) } : null;
}

export function parseWindowDrag(x: unknown, y: unknown, x2: unknown, y2: unknown): { x: number; y: number; x2: number; y2: number } | null {
  const action = parseWindowAction('coord', { name: 'drag', x: parseLooseNumber(x), y: parseLooseNumber(y), x2: parseLooseNumber(x2), y2: parseLooseNumber(y2), coordinateSpace: 'normalized-window' });
  return action && action.name === 'drag' ? { x: action.x, y: action.y, x2: action.x2, y2: action.y2 } : null;
}

export function parseWindowTypeText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return null;
  return value;
}

const WRITABLE_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXComboBox']);

export function isOwnMacWindow(row: { app?: string; bundleId?: string; pid?: number }): boolean {
  const bundle = (row.bundleId ?? '').trim();
  if (bundle === 'com.leoyuan.leocodebox') return true;
  const app = (row.app ?? '').trim().toLowerCase();
  if (app === 'leocodebox' || app.startsWith('leocodebox helper')) return true;
  return row.pid === process.pid;
}

export function pickBindableWindow<T extends { frontmost: boolean; onScreen?: boolean; app?: string; bundleId?: string; pid?: number }>(rows: T[]): T | undefined {
  const usable = rows.filter((row) => !isOwnMacWindow(row) && row.onScreen !== false);
  return usable.find((row) => row.frontmost) ?? usable[0];
}

export type BindableWindowRow = {
  snapshotId: string;
  app: string;
  title: string;
  pid: number;
  windowId: string;
  frontmost: boolean;
};

export function pickWritableWindowField(elements: WindowElement[] | undefined, elementId?: string): WindowElement | null {
  const writable = (elements ?? []).filter((item) => item.enabled && item.settableValue && !item.redacted && WRITABLE_ROLES.has(item.role));
  if (elementId) return writable.find((item) => item.id === elementId) ?? null;
  return writable.find((item) => item.focused) ?? writable[0] ?? null;
}

export function parseWindowMenuPath(value: unknown): string[] | null {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\s*[>/·]\s*/)
      : null;
  if (!raw) return null;
  const path = raw.map((item) => String(item ?? '').trim()).filter((item) => item.length > 0 && item.length <= 160);
  return path.length >= 2 && path.length <= 6 ? path : null;
}

export function sameWindowMenuPath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function pickUsableWindowMenus(
  menus: Array<{ path: string[]; enabled: boolean }> | undefined,
  limit = 24,
): Array<{ path: string[] }> {
  const seen = new Set<string>();
  const out: Array<{ path: string[] }> = [];
  for (const row of menus ?? []) {
    if (!row.enabled) continue;
    const path = parseWindowMenuPath(row.path);
    if (!path) continue;
    const key = path.join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path });
    if (out.length >= limit) break;
  }
  return out;
}

function sameWindow(ref: WindowRef, next: WindowObservation): boolean {
  return ref.pid === next.pid && ref.windowId === next.windowId
    && (!ref.bundleId || ref.bundleId === next.bundleId)
    && (ref.processStartedAt === undefined || ref.processStartedAt === next.processStartedAt);
}

export class ExactWindowStore {
  private readonly snapshots = new Map<string, WindowSnapshot>();
  private readonly sessionBind = new Map<string, string>();

  constructor(private readonly now: () => number = () => Date.now(), private readonly machine = os.hostname()) {}

  capture(input: WindowObservation): WindowSnapshot {
    const ref: WindowRef = { machine: this.machine, app: input.app, pid: input.pid, windowId: input.windowId, title: input.title,
      ...(input.bundleId ? { bundleId: input.bundleId } : {}),
      ...(input.processStartedAt !== undefined ? { processStartedAt: input.processStartedAt } : {}),
    };
    const snapshot: WindowSnapshot = {
      snapshotId: `ws_${randomBytes(12).toString('hex')}`,
      ref,
      frontmost: input.frontmost,
      bounds: input.bounds,
      capturedAt: this.now(),
      hash: createHash('sha256').update(JSON.stringify([ref, input.frontmost, input.bounds, input.stateHash])).digest('hex').slice(0, 24),
      observation: { ...input },
    };
    // Images are ephemeral evidence, not a screenshot archive. Keep at most
    // four while retaining lightweight metadata for older session bindings.
    const images = [...this.snapshots.values()].filter((item) => item.observation?.image);
    for (const previous of images.slice(0, input.image ? Math.max(0, images.length - 3) : Math.max(0, images.length - 4))) {
      if (previous.observation) delete previous.observation.image;
    }
    this.snapshots.set(snapshot.snapshotId, snapshot);
    while (this.snapshots.size > MAX_WINDOW_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value!;
      this.snapshots.delete(oldest);
      for (const [sessionId, id] of this.sessionBind) if (id === oldest) this.sessionBind.delete(sessionId);
    }
    return snapshot;
  }

  get(snapshotId: string): WindowSnapshot | undefined { return this.snapshots.get(snapshotId); }
  isStale(snapshot: WindowSnapshot): boolean { const age = this.now() - snapshot.capturedAt; return age < 0 || age > WINDOW_SNAPSHOT_FRESH_MS; }
  bindSession(sessionId: string, snapshotId: string): void {
    if (!this.snapshots.has(snapshotId)) throw new WindowOperationError('unknown-snapshot', '没有这个窗口快照。');
    this.sessionBind.set(sessionId, snapshotId);
  }
  sessionSnapshot(sessionId: string): WindowSnapshot | undefined {
    const id = this.sessionBind.get(sessionId);
    return id ? this.snapshots.get(id) : undefined;
  }

  private replace(snapshotId: string, observation: WindowObservation): WindowSnapshot {
    const previous = this.snapshots.get(snapshotId);
    if (!previous) throw new WindowOperationError('unknown-snapshot', '没有这个窗口快照。');
    if (!sameWindow(previous.ref, observation)) throw new WindowOperationError('window-changed', '窗口或进程身份已改变，请重新选择窗口。');
    const captured = this.capture(observation);
    for (const [sessionId, bound] of this.sessionBind) if (bound === snapshotId) this.sessionBind.set(sessionId, captured.snapshotId);
    return captured;
  }

  async observe(snapshotId: string, driver?: ExactWindowDriver, options?: WindowOperationOptions): Promise<WindowSnapshot> {
    const previous = this.snapshots.get(snapshotId);
    if (!previous) throw new WindowOperationError('unknown-snapshot', '没有这个窗口快照。');
    if (!driver) throw new WindowOperationError('observation-unavailable', 'Native window observation is unavailable.');
    const observation = await driver.observe(previous.ref, options);
    return this.replace(snapshotId, observation);
  }

  async act(snapshotId: string, kind: string, value?: unknown, driver?: ExactWindowDriver, options?: WindowOperationOptions): Promise<WindowActionResult> {
    const snap = this.snapshots.get(snapshotId);
    if (!snap) return { ok: false, reason: 'unknown-snapshot', message: '没有这个窗口快照。' };
    if (this.isStale(snap)) return { ok: false, reason: 'snapshot-expired', message: '窗口快照已过期，请先重观察，再执行。' };
    if (!snap.frontmost && (kind === 'coord' || kind === 'key')) {
      return { ok: false, reason: 'background-blocked', message: kind === 'key' ? '按键只允许当前前台窗口。' : '坐标动作只允许当前前台窗口。' };
    }
    const action = parseWindowAction(kind, value);
    if (!action || !driver) return { ok: false, reason: 'unsupported-action', message: '请提供当前原生窗口支持的明确动作；没有动作不会执行。' };
    try {
      const result = await driver.execute(snap, kind as WindowActionKind, action, options);
      if (!result.receipt.attempted || !result.receipt.verified) {
        return { ok: false, reason: 'verification-failed', message: '动作结果未通过原生回读验证，请先观察，不要自动重试。', receipt: result.receipt };
      }
      return { ok: true, snapshot: this.replace(snapshotId, result.observation), receipt: result.receipt };
    } catch (failure) {
      if (failure instanceof WindowOperationError) return { ok: false, reason: failure.reason, message: failure.message, ...(failure.receipt ? { receipt: failure.receipt } : {}) };
      return { ok: false, reason: 'execution-failed', message: '原生窗口操作失败，请重新观察目标。' };
    }
  }

  summary(sessionId: string): Record<string, unknown> | undefined {
    const snap = this.sessionSnapshot(sessionId);
    if (!snap) return undefined;
    return { machine: snap.ref.machine, app: snap.ref.app, pid: snap.ref.pid, window_id: snap.ref.windowId,
      title: snap.ref.title, snapshot_id: snap.snapshotId, frontmost: snap.frontmost, stale: this.isStale(snap) };
  }
}

export const exactWindows = new ExactWindowStore();
