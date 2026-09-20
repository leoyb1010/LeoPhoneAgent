import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { findAppRoot, getModuleDir } from '../../utils/runtime-paths.js';

import {
  exactWindows, isOwnMacWindow, parseNormalizedClickPoint, parseWindowDrag, parseWindowNamedKey, parseWindowScroll, parseWindowTypeText, pickBindableWindow, pickWritableWindowField, WINDOW_SNAPSHOT_FRESH_MS, WindowOperationError,
  type BindableWindowRow,
  type ExactWindowDriver, type WindowAction, type WindowActionKind, type WindowActionReceipt,
  type WindowElement, type WindowFailureReason, type WindowObservation, type WindowOperationOptions,
  type WindowPermissions, type WindowRef, type WindowSnapshot,
} from './exact-window.js';

const HELPER_PATH = path.join(findAppRoot(getModuleDir(import.meta.url)), 'native', 'mac-window', 'bin', 'leo-window-helper');
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
const REASONS = new Set<WindowFailureReason>([
  'unknown-snapshot', 'snapshot-expired', 'background-blocked', 'unsupported-action', 'unsupported-platform',
  'helper-unavailable', 'permission-denied', 'window-gone', 'window-changed', 'target-ambiguous', 'window-occluded',
  'invalid-request', 'timeout', 'cancelled', 'verification-failed', 'observation-unavailable', 'execution-failed',
  'element-changed', 'element-unavailable', 'scene-changed',
]);
export type NativeWindowRequest = {
  protocolVersion: 1;
  operation: 'list' | 'permissions' | 'observe' | 'act';
  ref?: WindowRef;
  expected?: WindowObservation;
  expiresAt?: number;
  capture?: boolean;
  elements?: boolean;
  kind?: WindowActionKind;
  action?: WindowAction;
};
export type NativeWindowTransport = (request: NativeWindowRequest, options?: WindowOperationOptions) => Promise<unknown>;

/** No shell, AppleScript interpolation or renderer-selected executable. */
export const runNativeWindow: NativeWindowTransport = (request, options = {}) => {
  if (process.platform !== 'darwin') return Promise.reject(new WindowOperationError('unsupported-platform', '原生窗口能力仅适用于 macOS。'));
  if (options.signal?.aborted) return Promise.reject(new WindowOperationError('cancelled', '窗口操作已取消。'));
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 256 * 1024) return Promise.reject(new WindowOperationError('invalid-request', '窗口请求超过大小限制。'));
  const timeout = Math.min(5000, Math.max(100, options.timeoutMs ?? 4000));
  return new Promise((resolve, reject) => {
    const child = execFile(HELPER_PATH, [], { encoding: 'utf8', timeout, maxBuffer: MAX_REPLY_BYTES, signal: options.signal, windowsHide: true }, (error, stdout) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const reason: WindowFailureReason = code === 'ENOENT' ? 'helper-unavailable'
          : options.signal?.aborted || error.name === 'AbortError' ? 'cancelled'
            : error.killed ? 'timeout' : 'observation-unavailable';
        // A timed-out action may already have reached the OS. Never retry it
        // automatically or claim that the target was untouched.
        const message = request.operation === 'act'
          ? '未收到可验证的窗口动作结果，请先重新观察，不要自动重试。'
          : reason === 'helper-unavailable' ? '原生窗口组件尚未安装。' : '无法在时限内读取原生窗口。';
        reject(new WindowOperationError(reason, message));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new WindowOperationError('observation-unavailable', '原生窗口响应无效。')); }
    });
    child.stdin?.on('error', () => { /* execFile completion owns the error. */ });
    child.stdin?.end(input);
  });
};

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 2048): value is string => typeof value === 'string' && value.length <= max;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function invalid(): never { throw new WindowOperationError('observation-unavailable', 'Invalid native window response.'); }
function permissions(value: unknown): WindowPermissions {
  const p = record(value);
  if (typeof p.accessibility !== 'boolean' || typeof p.screenCapture !== 'boolean' || typeof p.postEvents !== 'boolean') return invalid();
  return { accessibility: p.accessibility, screenCapture: p.screenCapture, postEvents: p.postEvents };
}
function parseReceipt(value: unknown): WindowActionReceipt {
  const r = record(value);
  if (typeof r.attempted !== 'boolean' || typeof r.verified !== 'boolean' || !text(r.verification, 128) || !text(r.action, 32) || !finite(r.observedAt)) return invalid();
  return { attempted: r.attempted, verified: r.verified, verification: r.verification, action: r.action, observedAt: r.observedAt };
}
function parseObservation(value: unknown): WindowObservation {
  const row = record(value);
  if (!text(row.app, 256) || !Number.isSafeInteger(row.pid) || Number(row.pid) <= 0
    || !text(row.windowId, 16) || !/^[1-9]\d*$/.test(row.windowId) || !text(row.title)
    || !text(row.bounds, 160) || row.bounds.split(',').length !== 4 || row.bounds.split(',').some((v) => !v.trim() || !Number.isFinite(Number(v))) || Number(row.bounds.split(',')[2]) <= 0 || Number(row.bounds.split(',')[3]) <= 0
    || typeof row.frontmost !== 'boolean' || !finite(row.processStartedAt) || row.processStartedAt <= 0
    || typeof row.onScreen !== 'boolean' || typeof row.occluded !== 'boolean' || !finite(row.scale) || row.scale <= 0 || row.scale > 8) return invalid();
  const result: WindowObservation = {
    app: row.app, pid: Number(row.pid), windowId: row.windowId, title: row.title, frontmost: row.frontmost,
    bounds: row.bounds, processStartedAt: row.processStartedAt, onScreen: row.onScreen, occluded: row.occluded,
    scale: row.scale, permissions: permissions(row.permissions),
    ...(typeof row.minimized === 'boolean' ? { minimized: row.minimized } : {}),
    ...(text(row.bundleId, 256) ? { bundleId: row.bundleId } : {}),
    ...(text(row.stateHash, 128) ? { stateHash: row.stateHash } : {}),
  };
  if (row.elements !== undefined) {
    if (!Array.isArray(row.elements) || row.elements.length > 256 || Buffer.byteLength(JSON.stringify(row.elements)) > 128 * 1024) return invalid();
    result.elements = row.elements.map((value): WindowElement => {
      const e = record(value);
      if (!text(e.id, 128) || !e.id || !Array.isArray(e.path) || e.path.length > 12 || !e.path.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 10000)
        || !text(e.role, 128) || !text(e.bounds, 160) || typeof e.enabled !== 'boolean' || typeof e.settableValue !== 'boolean'
        || typeof e.redacted !== 'boolean' || !Array.isArray(e.actions) || e.actions.length > 20 || !e.actions.every((a) => text(a, 128))) return invalid();
      return { id: e.id, path: e.path as number[], role: e.role, bounds: e.bounds, enabled: e.enabled, settableValue: e.settableValue,
        actions: e.actions as string[], redacted: e.redacted, focused: e.focused === true,
        ...(text(e.subrole, 128) ? { subrole: e.subrole } : {}), ...(text(e.identifier, 256) ? { identifier: e.identifier } : {}),
        ...(text(e.title) ? { title: e.title } : {}), ...(!e.redacted && text(e.value, 4096) ? { value: e.value } : {}),
      };
    });
    result.elementsTruncated = row.elementsTruncated === true;
  }
  if (row.menus !== undefined) {
    if (!Array.isArray(row.menus) || row.menus.length > 64 || Buffer.byteLength(JSON.stringify(row.menus)) > 32 * 1024) return invalid();
    result.menus = row.menus.map((value) => {
      const menu = record(value);
      if (!Array.isArray(menu.path) || menu.path.length > 6 || !menu.path.every((item) => text(item, 160)) || typeof menu.enabled !== 'boolean') return invalid();
      return { path: menu.path as string[], enabled: menu.enabled };
    });
  }
  if (row.image !== undefined) {
    const image = record(row.image);
    if (image.mimeType !== 'image/jpeg' || !text(image.data, 1400000) || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) || image.data.length % 4 !== 0
      || !Number.isInteger(image.width) || !Number.isInteger(image.height) || Number(image.width) < 1 || Number(image.height) < 1
      || Number(image.width) > 1024 || Number(image.height) > 1024 || !finite(image.scaleX) || image.scaleX <= 0 || !finite(image.scaleY) || image.scaleY <= 0
      || !text(image.hash, 64)) return invalid();
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.length > 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== image.hash) return invalid();
    result.image = { mimeType: 'image/jpeg', data: image.data, width: Number(image.width), height: Number(image.height), scaleX: image.scaleX, scaleY: image.scaleY, hash: image.hash };
  }
  return result;
}

export function createMacWindowDriver(transport: NativeWindowTransport = runNativeWindow) {
  const call = async (request: NativeWindowRequest, options?: WindowOperationOptions) => {
    const response = record(await transport(request, options));
    if (response.protocolVersion !== 1 || typeof response.ok !== 'boolean') return invalid();
    if (!response.ok) {
      const reason = REASONS.has(response.reason as WindowFailureReason) ? response.reason as WindowFailureReason : 'observation-unavailable';
      throw new WindowOperationError(reason, text(response.message, 512) ? response.message : '原生窗口请求失败。', response.receipt ? parseReceipt(response.receipt) : undefined);
    }
    return response;
  };
  return {
    async permissions(options?: WindowOperationOptions): Promise<WindowPermissions> {
      return permissions((await call({ protocolVersion: 1, operation: 'permissions' }, options)).permissions);
    },
    async list(options?: WindowOperationOptions): Promise<WindowObservation[]> {
      const response = await call({ protocolVersion: 1, operation: 'list' }, options);
      if (!Array.isArray(response.windows) || response.windows.length > 128) return invalid();
      return response.windows.map(parseObservation);
    },
    async observe(ref: WindowRef, options?: WindowOperationOptions): Promise<WindowObservation> {
      return parseObservation((await call({ protocolVersion: 1, operation: 'observe', ref, capture: options?.capture === true, elements: options?.elements !== false }, options)).observation);
    },
    async execute(snapshot: WindowSnapshot, kind: WindowActionKind, action: WindowAction, options?: WindowOperationOptions) {
      const response = await call({ protocolVersion: 1, operation: 'act', ref: snapshot.ref, expected: snapshot.observation ? { ...snapshot.observation,
        ...(snapshot.observation.image ? { image: { ...snapshot.observation.image, data: '' } } : {}) } : undefined,
        expiresAt: snapshot.capturedAt + WINDOW_SNAPSHOT_FRESH_MS, kind, action }, options);
      return { observation: parseObservation(response.observation), receipt: parseReceipt(response.receipt) };
    },
  } satisfies ExactWindowDriver & { list: (options?: WindowOperationOptions) => Promise<WindowObservation[]>; permissions: (options?: WindowOperationOptions) => Promise<WindowPermissions> };
}

export const macWindowDriver = createMacWindowDriver();
export type ListedWindow = WindowObservation;
export const listMacWindows = (options?: WindowOperationOptions) => macWindowDriver.list(options);
export const captureListed = (row: ListedWindow): WindowSnapshot => exactWindows.capture(row);

export async function bindFrontmostToSession(sessionId: string, options?: WindowOperationOptions): Promise<WindowSnapshot | null> {
  const front = pickBindableWindow(await listMacWindows(options));
  if (!front) return null;
  const snap = captureListed(front);
  exactWindows.bindSession(sessionId, snap.snapshotId);
  return snap;
}

export async function listBindableSessionWindows(
  options?: WindowOperationOptions,
  store = exactWindows,
  list = listMacWindows,
): Promise<BindableWindowRow[]> {
  const listed = await list(options);
  return listed.filter((row) => !isOwnMacWindow(row) && row.onScreen !== false).slice(0, 32).map((row) => {
    const snap = store.capture(row);
    return { snapshotId: snap.snapshotId, app: row.app, title: row.title, pid: row.pid, windowId: row.windowId, frontmost: row.frontmost };
  });
}

export async function bindSessionWindow(
  sessionId: string,
  snapshotId?: unknown,
  options?: WindowOperationOptions,
  store = exactWindows,
  list = listMacWindows,
): Promise<{ ok: true; app: string; title: string } | { ok: false; reason: string; message: string }> {
  const wanted = typeof snapshotId === 'string' && snapshotId.trim() && snapshotId.length <= 128 ? snapshotId.trim() : undefined;
  if (wanted) {
    const snap = store.get(wanted);
    if (!snap) return { ok: false, reason: 'unknown-snapshot', message: '没有这个窗口快照。' };
    if (isOwnMacWindow(snap.ref)) return { ok: false, reason: 'invalid-request', message: '不能绑自己这扇窗。' };
    store.bindSession(sessionId, snap.snapshotId);
    return { ok: true, app: snap.ref.app, title: snap.ref.title };
  }
  const snap = await bindFrontmostToSession(sessionId, options);
  if (!snap) return { ok: false, reason: 'window-gone', message: '没有可绑的其他窗口。' };
  return { ok: true, app: snap.ref.app, title: snap.ref.title };
}

export async function peekBoundSessionWindow(
  sessionId: string,
  options?: WindowOperationOptions,
  store = exactWindows,
  driver = macWindowDriver,
  list = listMacWindows,
): Promise<{ ok: true; app: string; title: string; image: { mimeType: string; data: string; width: number; height: number } | null } | { ok: false; reason: string; message: string }> {
  const bound = store.sessionSnapshot(sessionId);
  if (!bound) return { ok: false, reason: 'unknown-snapshot', message: '这个会话还没有绑过窗口。' };
  const listed = await list(options);
  const match = listed.find((row) => row.pid === bound.ref.pid && row.windowId === bound.ref.windowId);
  if (!match) return { ok: false, reason: 'window-gone', message: '绑过的窗口已经不在了。' };
  let snap = store.capture(match);
  store.bindSession(sessionId, snap.snapshotId);
  try {
    snap = await store.observe(snap.snapshotId, driver, { ...options, capture: true, elements: false });
  } catch (error) {
    if (error instanceof WindowOperationError && error.reason !== 'observation-unavailable' && error.reason !== 'permission-denied') {
      return { ok: false, reason: error.reason, message: error.message };
    }
    return { ok: true, app: snap.ref.app, title: snap.ref.title, image: null };
  }
  const image = snap.observation?.image;
  return {
    ok: true, app: snap.ref.app, title: snap.ref.title,
    image: image ? { mimeType: image.mimeType, data: image.data, width: image.width, height: image.height } : null,
  };
}

/** 把会话绑过的那扇窗提到前面。快照只有 3 秒寿命,所以先按 pid/windowId 再认一次,再 focus。 */
export async function raiseBoundSessionWindow(
  sessionId: string,
  options?: WindowOperationOptions,
  store = exactWindows,
  driver = macWindowDriver,
  list = listMacWindows,
): Promise<{ ok: true; app: string; title: string } | { ok: false; reason: string; message: string }> {
  const bound = store.sessionSnapshot(sessionId);
  if (!bound) return { ok: false, reason: 'unknown-snapshot', message: '这个会话还没有绑过窗口。' };
  const listed = await list(options);
  const match = listed.find((row) => row.pid === bound.ref.pid && row.windowId === bound.ref.windowId);
  if (!match) return { ok: false, reason: 'window-gone', message: '绑过的窗口已经不在了。' };
  const fresh = store.capture(match);
  store.bindSession(sessionId, fresh.snapshotId);
  const result = await store.act(fresh.snapshotId, 'ax', { name: 'focus' }, driver, options);
  if (!result.ok) return { ok: false, reason: result.reason, message: result.message };
  return { ok: true, app: result.snapshot.ref.app, title: result.snapshot.ref.title };
}

/** 点绑过的那扇窗。快照会过期且坐标只能打前台,所以先 raise 再按窗口内相对位置点。 */
export async function clickBoundSessionWindow(
  sessionId: string,
  x: unknown,
  y: unknown,
  options?: WindowOperationOptions,
  store = exactWindows,
  driver = macWindowDriver,
  list = listMacWindows,
): Promise<{ ok: true; app: string; title: string; x: number; y: number } | { ok: false; reason: string; message: string }> {
  const point = parseNormalizedClickPoint(x, y);
  if (!point) return { ok: false, reason: 'invalid-request', message: '点击位置必须是窗口内的相对坐标（0 到 1 之间，不含边）。' };
  const raised = await raiseBoundSessionWindow(sessionId, options, store, driver, list);
  if (!raised.ok) return raised;
  const current = store.sessionSnapshot(sessionId);
  if (!current) return { ok: false, reason: 'unknown-snapshot', message: '这个会话还没有绑过窗口。' };
  let snap = current;
  if (store.isStale(snap) || !snap.frontmost) {
    const listed = await list(options);
    const { pid, windowId } = snap.ref;
    const match = listed.find((row) => row.pid === pid && row.windowId === windowId);
    if (!match) return { ok: false, reason: 'window-gone', message: '绑过的窗口已经不在了。' };
    snap = store.capture(match);
    store.bindSession(sessionId, snap.snapshotId);
    if (!snap.frontmost) return { ok: false, reason: 'background-blocked', message: '窗口提到前面之后仍不在前台，不能点。' };
  }
  const result = await store.act(snap.snapshotId, 'coord', { name: 'click', x: point.x, y: point.y, coordinateSpace: 'normalized-window' }, driver, options);
  if (!result.ok) return { ok: false, reason: result.reason, message: result.message };
  return { ok: true, app: result.snapshot.ref.app, title: result.snapshot.ref.title, x: point.x, y: point.y };
}

/** 往绑过的窗口里写字。先提到前面再读可写框:指定 id、否则焦点框、否则第一个。 */
export async function typeBoundSessionWindow(
  sessionId: string,
  value: unknown,
  elementId?: unknown,
  options?: WindowOperationOptions,
  store = exactWindows,
  driver = macWindowDriver,
  list = listMacWindows,
): Promise<{ ok: true; app: string; title: string; elementId: string } | { ok: false; reason: string; message: string }> {
  const text = parseWindowTypeText(value);
  if (!text) return { ok: false, reason: 'invalid-request', message: '要写入的文字不能为空，也不能超过 4096 字。' };
  const wantedId = typeof elementId === 'string' && elementId.trim() && elementId.length <= 128 ? elementId.trim() : undefined;
  const raised = await raiseBoundSessionWindow(sessionId, options, store, driver, list);
  if (!raised.ok) return raised;
  const current = store.sessionSnapshot(sessionId);
  if (!current) return { ok: false, reason: 'unknown-snapshot', message: '这个会话还没有绑过窗口。' };
  let observed;
  try {
    observed = await store.observe(current.snapshotId, driver, { ...options, elements: true });
  } catch (error) {
    if (error instanceof WindowOperationError) return { ok: false, reason: error.reason, message: error.message };
    return { ok: false, reason: 'observation-unavailable', message: '读不到这个窗口里的输入框。' };
  }
  const field = pickWritableWindowField(observed.observation?.elements, wantedId);
  if (!field) {
    return {
      ok: false,
      reason: wantedId ? 'element-unavailable' : 'element-unavailable',
      message: wantedId ? '指定的输入框已经不在或不能写。' : '这个窗口里没有能写的输入框。',
    };
  }
  const result = await store.act(observed.snapshotId, 'ax', { name: 'setValue', elementId: field.id, value: text }, driver, options);
  if (!result.ok) return { ok: false, reason: result.reason, message: result.message };
  return { ok: true, app: result.snapshot.ref.app, title: result.snapshot.ref.title, elementId: field.id };
}

/** 往绑过的窗口打一个具名按键。先提到前面，回车/Esc/方向键走 HID，不靠 AX。 */
export async function keyBoundSessionWindow(
  sessionId: string,
  value: unknown,
  options?: WindowOperationOptions,
  store = exactWindows,
  driver = macWindowDriver,
  list = listMacWindows,
): Promise<{ ok: true; app: string; title: string; key: string } | { ok: false; reason: string; message: string }> {
  const key = parseWindowNamedKey(value);
  if (!key) return { ok: false, reason: 'invalid-request', message: '只接受回车、Esc、Tab、空格、删除和方向键。' };
  const raised = await raiseBoundSessionWindow(sessionId, options, store, driver, list);
  if (!raised.ok) return raised;
  const current = store.sessionSnapshot(sessionId);
  if (!current) return { ok: false, reason: 'unknown-snapshot', message: '这个会话还没有绑过窗口。' };
  let snap = current;
  if (store.isStale(snap) || !snap.frontmost) {
    const listed = await list(options);
    const { pid, windowId } = snap.ref;
    const match = listed.find((row) => row.pid === pid && row.windowId === windowId);
    if (!match) return { ok: false, reason: 'window-gone', message: '绑过的窗口已经不在了。' };
    snap = store.capture(match);
    store.bindSession(sessionId, snap.snapshotId);
    if (!snap.frontmost) return { ok: false, reason: 'background-blocked', message: '窗口提到前面之后仍不在前台，不能按键。' };
  }
  const result = await store.act(snap.snapshotId, 'key', { name: 'key', key }, driver, options);
  if (!result.ok) return { ok: false, reason: result.reason, message: result.message };
  return { ok: true, app: result.snapshot.ref.app, title: result.snapshot.ref.title, key };
}

/** 在绑过的窗口里滚。先提到前面，再按窗口内相对位置打滚轮。 */
export async function scrollBoundSessionWindow(
  sessionId: string,
  x: unknown,
  y: unknown,
  dx: unknown,
  dy: unknown,
  options?: WindowOperationOptions,
  store = exactWindows,
  driver = macWindowDriver,
  list = listMacWindows,
): Promise<{ ok: true; app: string; title: string; x: number; y: number; dx?: number; dy?: number } | { ok: false; reason: string; message: string }> {
  const gesture = parseWindowScroll(x, y, dx, dy);
  if (!gesture) return { ok: false, reason: 'invalid-request', message: '滚动要有窗口内相对位置，以及不超过 24 的滚动量。' };
  const raised = await raiseBoundSessionWindow(sessionId, options, store, driver, list);
  if (!raised.ok) return raised;
  const current = store.sessionSnapshot(sessionId);
  if (!current) return { ok: false, reason: 'unknown-snapshot', message: '这个会话还没有绑过窗口。' };
  let snap = current;
  if (store.isStale(snap) || !snap.frontmost) {
    const listed = await list(options);
    const { pid, windowId } = snap.ref;
    const match = listed.find((row) => row.pid === pid && row.windowId === windowId);
    if (!match) return { ok: false, reason: 'window-gone', message: '绑过的窗口已经不在了。' };
    snap = store.capture(match);
    store.bindSession(sessionId, snap.snapshotId);
    if (!snap.frontmost) return { ok: false, reason: 'background-blocked', message: '窗口提到前面之后仍不在前台，不能滚。' };
  }
  const result = await store.act(snap.snapshotId, 'coord', { name: 'scroll', ...gesture, coordinateSpace: 'normalized-window' }, driver, options);
  if (!result.ok) return { ok: false, reason: result.reason, message: result.message };
  return { ok: true, app: result.snapshot.ref.app, title: result.snapshot.ref.title, ...gesture };
}

/** 在绑过的窗口里拖。先提到前面，再从相对起点拖到终点。 */
export async function dragBoundSessionWindow(
  sessionId: string,
  x: unknown,
  y: unknown,
  x2: unknown,
  y2: unknown,
  options?: WindowOperationOptions,
  store = exactWindows,
  driver = macWindowDriver,
  list = listMacWindows,
): Promise<{ ok: true; app: string; title: string; x: number; y: number; x2: number; y2: number } | { ok: false; reason: string; message: string }> {
  const gesture = parseWindowDrag(x, y, x2, y2);
  if (!gesture) return { ok: false, reason: 'invalid-request', message: '拖动要有窗口内两个不同的相对位置。' };
  const raised = await raiseBoundSessionWindow(sessionId, options, store, driver, list);
  if (!raised.ok) return raised;
  const current = store.sessionSnapshot(sessionId);
  if (!current) return { ok: false, reason: 'unknown-snapshot', message: '这个会话还没有绑过窗口。' };
  let snap = current;
  if (store.isStale(snap) || !snap.frontmost) {
    const listed = await list(options);
    const { pid, windowId } = snap.ref;
    const match = listed.find((row) => row.pid === pid && row.windowId === windowId);
    if (!match) return { ok: false, reason: 'window-gone', message: '绑过的窗口已经不在了。' };
    snap = store.capture(match);
    store.bindSession(sessionId, snap.snapshotId);
    if (!snap.frontmost) return { ok: false, reason: 'background-blocked', message: '窗口提到前面之后仍不在前台，不能拖。' };
  }
  const result = await store.act(snap.snapshotId, 'coord', { name: 'drag', ...gesture, coordinateSpace: 'normalized-window' }, driver, options);
  if (!result.ok) return { ok: false, reason: result.reason, message: result.message };
  return { ok: true, app: result.snapshot.ref.app, title: result.snapshot.ref.title, ...gesture };
}

export async function exactWindowCapabilities(options?: WindowOperationOptions, driver = macWindowDriver) {
  try {
    const granted = await driver.permissions(options);
    return { available: true, protocolVersion: 1, readiness: 'requires-target-validation', permissions: granted, actions: {
      observe: true, capture: granted.screenCapture, ax: granted.accessibility, menu: granted.accessibility,
      coord: granted.accessibility && granted.screenCapture && granted.postEvents,
      key: granted.accessibility && granted.postEvents,
      scroll: granted.accessibility && granted.postEvents,
      drag: granted.accessibility && granted.postEvents,
    } };
  } catch (error) {
    return { available: false, protocolVersion: 1, reason: error instanceof WindowOperationError ? error.reason : 'helper-unavailable' };
  }
}
