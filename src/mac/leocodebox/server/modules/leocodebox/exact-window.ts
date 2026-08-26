import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';

export const WINDOW_SNAPSHOT_FRESH_MS = 3_000;

export type WindowRef = {
  machine: string;
  app: string;
  pid: number;
  windowId: string;
  title: string;
};

export type WindowSnapshot = {
  snapshotId: string;
  ref: WindowRef;
  frontmost: boolean;
  bounds: string;
  capturedAt: number;
  hash: string;
};

export type WindowActionKind = 'ax' | 'menu' | 'coord';

export type WindowActionResult =
  | { ok: true; snapshot: WindowSnapshot }
  | { ok: false; reason: 'unknown-snapshot' | 'snapshot-expired' | 'background-blocked'; message: string };

function fingerprint(ref: WindowRef, frontmost: boolean, bounds: string): string {
  return createHash('sha256')
    .update(`${ref.machine}|${ref.app}|${ref.pid}|${ref.windowId}|${ref.title}|${frontmost}|${bounds}`)
    .digest('hex')
    .slice(0, 16);
}

export class ExactWindowStore {
  private readonly snapshots = new Map<string, WindowSnapshot>();
  private readonly sessionBind = new Map<string, string>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly machine = os.hostname(),
  ) {}

  capture(input: Omit<WindowRef, 'machine'> & { frontmost: boolean; bounds: string }): WindowSnapshot {
    const ref: WindowRef = { machine: this.machine, ...input };
    const snapshot: WindowSnapshot = {
      snapshotId: `ws_${randomBytes(6).toString('hex')}`,
      ref,
      frontmost: input.frontmost,
      bounds: input.bounds,
      capturedAt: this.now(),
      hash: fingerprint(ref, input.frontmost, input.bounds),
    };
    this.snapshots.set(snapshot.snapshotId, snapshot);
    return snapshot;
  }

  get(snapshotId: string): WindowSnapshot | undefined {
    return this.snapshots.get(snapshotId);
  }

  isStale(snapshot: WindowSnapshot): boolean {
    return this.now() - snapshot.capturedAt > WINDOW_SNAPSHOT_FRESH_MS;
  }

  bindSession(sessionId: string, snapshotId: string): void {
    if (!this.snapshots.has(snapshotId)) throw new Error('unknown-snapshot');
    this.sessionBind.set(sessionId, snapshotId);
  }

  sessionSnapshot(sessionId: string): WindowSnapshot | undefined {
    const id = this.sessionBind.get(sessionId);
    return id ? this.snapshots.get(id) : undefined;
  }

  observe(snapshotId: string, next?: { frontmost?: boolean; bounds?: string; title?: string }): WindowSnapshot {
    const prev = this.snapshots.get(snapshotId);
    if (!prev) throw new Error('unknown-snapshot');
    const captured = this.capture({
      app: prev.ref.app,
      pid: prev.ref.pid,
      windowId: prev.ref.windowId,
      title: next?.title ?? prev.ref.title,
      frontmost: next?.frontmost ?? prev.frontmost,
      bounds: next?.bounds ?? prev.bounds,
    });
    for (const [sessionId, bound] of this.sessionBind) {
      if (bound === snapshotId) this.sessionBind.set(sessionId, captured.snapshotId);
    }
    return captured;
  }

  act(snapshotId: string, kind: WindowActionKind): WindowActionResult {
    const snap = this.snapshots.get(snapshotId);
    if (!snap) {
      return { ok: false, reason: 'unknown-snapshot', message: '没有这个窗口快照。' };
    }
    if (this.isStale(snap)) {
      return {
        ok: false,
        reason: 'snapshot-expired',
        message: '窗口快照已过期。后台操作必须先重观察，再执行。',
      };
    }
    // ponytail: coord on a background window waits for T4.5 screen-capture.
    if (!snap.frontmost && kind === 'coord') {
      return {
        ok: false,
        reason: 'background-blocked',
        message: '后台窗口不用坐标点选。切到前台，或用菜单/辅助功能。',
      };
    }
    return { ok: true, snapshot: this.observe(snapshotId) };
  }

  summary(sessionId: string): Record<string, unknown> | undefined {
    const snap = this.sessionSnapshot(sessionId);
    if (!snap) return undefined;
    return {
      machine: snap.ref.machine,
      app: snap.ref.app,
      pid: snap.ref.pid,
      window_id: snap.ref.windowId,
      title: snap.ref.title,
      snapshot_id: snap.snapshotId,
      frontmost: snap.frontmost,
      stale: this.isStale(snap),
    };
  }
}

export const exactWindows = new ExactWindowStore();
