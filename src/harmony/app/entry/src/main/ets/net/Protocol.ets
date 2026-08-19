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
}

export class HarnessKind {
  key: string = '';
  name: string = '';
}

export const DEFAULT_API_ROOT =
  'https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api';
export const PAIR_PREFIX = 'leoagent-body:v1|';

export function normalizeApiRoot(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
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
    const name = `${item['name'] ?? ''}`.trim();
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

export function encodePair(apiRoot: string, machine: string): string {
  return PAIR_PREFIX + JSON.stringify({
    'apiRoot': normalizeApiRoot(apiRoot),
    'machine': machine.trim()
  });
}

export function decodePair(raw: string): PairPayload | null {
  const text = raw.trim();
  let jsonText = '';
  if (text.startsWith(PAIR_PREFIX)) {
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
