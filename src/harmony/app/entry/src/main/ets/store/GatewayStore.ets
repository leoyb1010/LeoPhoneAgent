import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import {
  DEFAULT_API_ROOT,
  RelayDiscoveredMachine,
  decodePair,
  normalizeApiRoot,
  sameApiRoot,
  sanitizeKey
} from '../net/Protocol';

const STORE = 'leo.harmony.gateway';

export class SavedHost {
  name: string = '';
  displayName: string = '';
  enabled: boolean = true;
  platform: string = '';
  online: boolean = false;
}

export class GatewayStore {
  apiRoot: string = DEFAULT_API_ROOT;
  key: string = '';
  hosts: SavedHost[] = [];
  lastError: string = '';

  async load(context: common.UIAbilityContext): Promise<void> {
    const store = await preferences.getPreferences(context, STORE);
    this.apiRoot = normalizeApiRoot(`${await store.get('apiRoot', DEFAULT_API_ROOT)}`);
    this.key = sanitizeKey(`${await store.get('key', '')}`);
    const rawHosts = `${await store.get('hosts', '[]')}`;
    try {
      const parsed = JSON.parse(rawHosts) as Object[];
      this.hosts = parsed.map((row: Object) => {
        const item = row as Record<string, Object>;
        const host = new SavedHost();
        host.name = `${item['name'] ?? ''}`;
        host.displayName = `${item['displayName'] ?? host.name}`;
        host.enabled = item['enabled'] === false ? false : true;
        host.platform = `${item['platform'] ?? ''}`;
        host.online = item['online'] === true;
        return host;
      }).filter((host: SavedHost) => host.name.length > 0);
    } catch (_err) {
      this.hosts = [];
    }
  }

  async save(context: common.UIAbilityContext): Promise<void> {
    const store = await preferences.getPreferences(context, STORE);
    await store.put('apiRoot', normalizeApiRoot(this.apiRoot));
    await store.put('key', sanitizeKey(this.key));
    await store.put('hosts', JSON.stringify(this.hosts));
    await store.flush();
  }

  upsertDiscovered(machines: RelayDiscoveredMachine[]): void {
    for (let i = 0; i < machines.length; i++) {
      const incoming = machines[i];
      let found = false;
      for (let j = 0; j < this.hosts.length; j++) {
        if (this.hosts[j].name === incoming.name) {
          this.hosts[j].platform = incoming.platform;
          this.hosts[j].online = incoming.online;
          found = true;
          break;
        }
      }
      if (!found) {
        const host = new SavedHost();
        host.name = incoming.name;
        host.displayName = incoming.name;
        host.enabled = true;
        host.platform = incoming.platform;
        host.online = incoming.online;
        this.hosts.push(host);
      }
    }
  }

  scanPairCode(raw: string): string {
    const pair = decodePair(raw);
    if (!pair) {
      return '不是本 App 的配对码。码里应是中继根和机器名。';
    }
    if (!sameApiRoot(pair.apiRoot, this.apiRoot)) {
      return '配对码里的中继不是你已经在用的那台。钥匙不会发到别的地址。';
    }
    const machine = new RelayDiscoveredMachine();
    machine.name = pair.machine;
    machine.online = false;
    this.upsertDiscovered([machine]);
    return `已加入 ${pair.machine}`;
  }
}

export const gatewayStore: GatewayStore = new GatewayStore();
