import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import {
  DEFAULT_API_ROOT,
  RelayDiscoveredMachine,
  decodePair,
  requireHttpsRoot,
  sameApiRoot,
  sanitizeKey
} from '../net/Protocol';
import { SecretStore } from './SecretStore';

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
  private loaded: boolean = false;
  private pending: Promise<void> | null = null;

  ensureLoaded(context: common.UIAbilityContext): Promise<void> {
    if (this.loaded) {
      return Promise.resolve();
    }
    if (!this.pending) {
      this.pending = this.load(context).catch((err: Error) => {
        this.pending = null;
        throw err;
      });
    }
    return this.pending;
  }

  async load(context: common.UIAbilityContext): Promise<void> {
    const store = await preferences.getPreferences(context, STORE);
    try {
      this.apiRoot = requireHttpsRoot(`${await store.get('apiRoot', DEFAULT_API_ROOT)}`);
    } catch (_err) {
      this.apiRoot = DEFAULT_API_ROOT;
    }
    this.key = sanitizeKey(await SecretStore.readKey());
    if (!this.key) {
      this.key = sanitizeKey(`${await store.get('key', '')}`);
      if (this.key.length >= 16) {
        try {
          await SecretStore.writeKey(this.key);
          await store.delete('key');
          await store.flush();
        } catch (_migrate) {
          // keep plaintext fallback until Asset Store is available
        }
      }
    }
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
    this.loaded = true;
  }

  async save(context: common.UIAbilityContext): Promise<void> {
    await this.ensureLoaded(context);
    this.apiRoot = requireHttpsRoot(this.apiRoot);
    const key = sanitizeKey(this.key);
    if (key.length > 0 && key.length < 16) {
      throw new Error('钥匙至少 16 位');
    }
    if (key.length >= 16) {
      this.key = key;
      await SecretStore.writeKey(key);
    }
    const store = await preferences.getPreferences(context, STORE);
    await store.put('apiRoot', this.apiRoot);
    if (key.length >= 16) {
      await store.delete('key');
    }
    await store.put('hosts', JSON.stringify(this.hosts));
    await store.flush();
  }

  upsertDiscovered(machines: RelayDiscoveredMachine[], markMissingOffline: boolean): void {
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
    if (markMissingOffline) {
      for (let j = 0; j < this.hosts.length; j++) {
        let seen = false;
        for (let i = 0; i < machines.length; i++) {
          if (machines[i].name === this.hosts[j].name) {
            seen = true;
            break;
          }
        }
        if (!seen) {
          this.hosts[j].online = false;
        }
      }
    }
  }

  scanPairCode(raw: string): string {
    if (sanitizeKey(this.key).length < 16) {
      return '先粘贴中继密钥，再加入这台身体。';
    }
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
    this.upsertDiscovered([machine], false);
    return `已加入 ${pair.machine}`;
  }
}

export const gatewayStore: GatewayStore = new GatewayStore();
