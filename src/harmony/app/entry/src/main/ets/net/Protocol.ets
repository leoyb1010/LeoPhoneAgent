export class RelayDiscoveredMachine {
  name: string = '';
  online: boolean = true;
  platform: string = '';
  server: string = '';
  version: string = '';
}

export class PairPayload {
  apiRoot: string = '';
  machine: string = '';
  join: string = '';
  exp: number = 0;
}

export class HarnessKind {
  key: string = '';
  name: string = '';
}

export const DEFAULT_API_ROOT =
  'https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api';
export const PAIR_PREFIX = 'leoagent-body:v1|';
export const PAIR_PREFIX_V2 = 'leoagent-body:v2|';

export function normalizeApiRoot(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function requireHttpsRoot(raw: string): string {
  const root = normalizeApiRoot(raw);
  if (!root.toLowerCase().startsWith('https://')) {
    throw new Error('中继根必须是 https://');
  }
  const rest = root.substring('https://'.length);
  if (!rest || rest.indexOf('@') >= 0 || rest.indexOf(' ') >= 0 || rest.indexOf('#') >= 0) {
    throw new Error('中继根不合法');
  }
  return root;
}

export function sameApiRoot(lhs: string, rhs: string): boolean {
  return normalizeApiRoot(lhs).toLowerCase() === normalizeApiRoot(rhs).toLowerCase();
}

export function harnessURL(apiRoot: string, machine: string): string {
  return normalizeApiRoot(apiRoot) + '/m/' + machine;
}

export function apiRootFromHarnessURL(raw: string): string {
  const index = raw.toLowerCase().lastIndexOf('/m/');
  if (index < 0) {
    return '';
  }
  const root = normalizeApiRoot(raw.substring(0, index));
  if (!root.toLowerCase().startsWith('https://')) {
    return '';
  }
  return root;
}

export function sanitizeKey(raw: string): string {
  return raw.trim().replace(/%+$/g, '').replace(/[\r\n]+/g, '');
}

export function sanitizeMachine(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > 80) {
    return '';
  }
  if (/[/\\?#%]/.test(name) || name.indexOf('..') >= 0) {
    return '';
  }
  return name;
}

export function displayName(machine: string): string {
  if (machine === 'LeoyuandeMacBook-Pro-2') {
    return 'MacBook Pro';
  }
  if (machine === 'LeodeMac-mini-2') {
    return 'Mac mini · cortex';
  }
  if (machine === 'LeoMac-Studio-2') {
    return 'Mac Studio';
  }
  return machine;
}

export function isHarmonyBody(machine: RelayDiscoveredMachine): boolean {
  return machine.platform === 'harmony';
}

export function isAndroidBody(machine: RelayDiscoveredMachine): boolean {
  if (isHarmonyBody(machine)) {
    return false;
  }
  return machine.platform === 'android' || machine.server === 'minis';
}

export function parseMachines(json: object): RelayDiscoveredMachine[] {
  const record = json as Record<string, Object>;
  const rows = record['machines'];
  if (!Array.isArray(rows)) {
    return [];
  }
  const out: RelayDiscoveredMachine[] = [];
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i] as Record<string, Object>;
    const name = sanitizeMachine(`${item['name'] ?? ''}`);
    if (!name) {
      continue;
    }
    const row = new RelayDiscoveredMachine();
    row.name = name;
    row.online = item['online'] === false ? false : true;
    row.platform = `${item['platform'] ?? ''}`;
    row.server = `${item['server'] ?? ''}`;
    row.version = `${item['version'] ?? ''}`;
    out.push(row);
  }
  return out;
}

export function encodePair(apiRoot: string, machine: string, join?: string, exp?: number): string {
  const body: Record<string, Object> = {
    'apiRoot': normalizeApiRoot(apiRoot),
    'machine': machine.trim()
  };
  const token = (join ?? '').trim();
  if (token.length > 0) {
    body['join'] = token;
    if (exp !== undefined && exp > 0) {
      body['exp'] = exp;
    }
    return PAIR_PREFIX_V2 + JSON.stringify(body);
  }
  return PAIR_PREFIX + JSON.stringify(body);
}

export function decodePair(raw: string): PairPayload | null {
  const text = raw.trim();
  let jsonText = '';
  if (text.startsWith(PAIR_PREFIX_V2)) {
    jsonText = text.substring(PAIR_PREFIX_V2.length);
  } else if (text.startsWith(PAIR_PREFIX)) {
    jsonText = text.substring(PAIR_PREFIX.length);
  } else if (text.startsWith('{')) {
    jsonText = text;
  } else {
    return null;
  }
  try {
    const obj = JSON.parse(jsonText) as Record<string, Object>;
    const apiRoot = normalizeApiRoot(`${obj['apiRoot'] ?? ''}`);
    const machine = sanitizeMachine(`${obj['machine'] ?? ''}`);
    if (!apiRoot || !machine || !apiRoot.toLowerCase().startsWith('https://')) {
      return null;
    }
    const payload = new PairPayload();
    payload.apiRoot = apiRoot;
    payload.machine = machine;
    payload.join = `${obj['join'] ?? ''}`.trim();
    payload.exp = Number(obj['exp'] ?? 0);
    return payload;
  } catch (_err) {
    return null;
  }
}

export function parseSseData(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) {
    return '';
  }
  return trimmed.substring(5).trim();
}

export function parseHarnessKinds(json: object): HarnessKind[] {
  const record = json as Record<string, Object>;
  const rows = record['harnesses'];
  if (!Array.isArray(rows)) {
    return [];
  }
  const out: HarnessKind[] = [];
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i] as Record<string, Object>;
    const key = `${item['key'] ?? ''}`;
    if (!key) {
      continue;
    }
    const kind = new HarnessKind();
    kind.key = key;
    const name = `${item['name'] ?? ''}`;
    kind.name = name.length > 0 ? name : key;
    out.push(kind);
  }
  return out;
}

export class RemoteTask {
  id: string = '';
  label: string = '';
}

/**
 * 打开远程机器时可以接着看的任务:同一个 Agent、没结束的,最近的在前,最多 5 个
 * (菜单一共 6 格,留一格给「新任务」)。Mac 桌面上的任务(source 为 desktop)也在里面,点开即接管,
 * 和 iOS、安卓一样。手机端的列表没有时间戳、按先后排,所以先倒过来再按时间排。
 */
export function parseRemoteTasks(json: object, harness: string): RemoteTask[] {
  const rows = (json as Record<string, Object>)['sessions'];
  if (!Array.isArray(rows)) {
    return [];
  }
  const items = (rows as Record<string, Object>[]).slice().reverse()
    .sort((a: Record<string, Object>, b: Record<string, Object>) =>
      Number(b['updated_at'] ?? 0) - Number(a['updated_at'] ?? 0));
  const out: RemoteTask[] = [];
  for (let i = 0; i < items.length && out.length < 5; i++) {
    const item = items[i];
    const id = `${item['session_id'] ?? ''}`;
    const status = `${item['status'] ?? ''}`;
    if (!id || `${item['harness'] ?? ''}` !== harness || ['completed', 'failed', 'cancelled'].indexOf(status) >= 0) {
      continue;
    }
    const title = `${item['title'] ?? ''}`.trim();
    const name = title.length > 18 ? `${title.substring(0, 18)}…` :
      (title.length > 0 ? title : `任务 ${id.substring(Math.max(0, id.length - 4))}`);
    let word = status === 'running' ? '进行中' : (status === 'waiting_for_approval' ? '等你批准' : '空闲');
    if (`${item['source'] ?? ''}` === 'desktop') {
      word = status === 'running' ? 'Mac 上在跑' : 'Mac 桌面任务';
    }
    const task = new RemoteTask();
    task.id = id;
    task.label = `${name} · ${word}`;
    out.push(task);
  }
  return out;
}
