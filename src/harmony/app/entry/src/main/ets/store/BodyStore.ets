import { fileIo } from '@kit.CoreFileKit';
import { common } from '@kit.AbilityKit';
import { encodePair, sanitizeKey, sanitizeMachine } from '../net/Protocol';
import { gatewayStore } from './GatewayStore';

class BodyFile {
  on: boolean = false;
  name: string = 'LeoHarmony';
}

export class BodyStore {
  on: boolean = false;
  name: string = 'LeoHarmony';
  online: boolean = false;
  lastError: string = '';
  private loaded: boolean = false;

  pairCode(): string {
    return encodePair(gatewayStore.apiRoot, this.name);
  }

  async load(context: common.UIAbilityContext): Promise<void> {
    if (this.loaded) {
      return;
    }
    const path = context.filesDir + '/body.json';
    if (fileIo.accessSync(path)) {
      try {
        const obj = JSON.parse(fileIo.readTextSync(path)) as Record<string, Object>;
        this.on = obj['on'] === true;
        const name = sanitizeMachine(`${obj['name'] ?? ''}`);
        if (name) {
          this.name = name;
        }
      } catch (_err) {
        this.on = false;
      }
    }
    this.loaded = true;
  }

  async save(context: common.UIAbilityContext): Promise<void> {
    const name = sanitizeMachine(this.name);
    if (!name) {
      throw new Error('身体名不合法');
    }
    this.name = name;
    const body = new BodyFile();
    body.on = this.on;
    body.name = this.name;
    const path = context.filesDir + '/body.json';
    const file = fileIo.openSync(path,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
    try {
      fileIo.writeSync(file.fd, JSON.stringify(body));
    } finally {
      fileIo.closeSync(file);
    }
  }

  canRegister(): string {
    if (sanitizeKey(gatewayStore.key).length < 16) {
      return '先填中继钥匙';
    }
    if (!this.name) {
      return '先写身体名';
    }
    return '';
  }
}

export const bodyStore: BodyStore = new BodyStore();
