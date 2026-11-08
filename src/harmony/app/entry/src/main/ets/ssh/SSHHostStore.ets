import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { AtomicTextFile } from '../store/AtomicFile';
import { BoundSecret } from '../store/BoundSecret';

export class SSHHost {
  id: string = '';
  label: string = '';
  host: string = '';
  port: number = 22;
  username: string = '';
  hostKey: string = '';
  auth: string = 'key';
  secretRef: string = '';
}
export class SSHCredential { privateKey: string = ''; passphrase: string = ''; password: string = ''; }
export function validateSSHHost(row: SSHHost): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/.test(row.host) || row.host.includes('..') ||
    !/^[A-Za-z0-9_.@+-]{1,128}$/.test(row.username) || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535) {
    throw new Error('SSH地址、端口或用户名无效');
  }
  row.hostKey = row.hostKey.trim().split(/\s+/).slice(0, 2).join(' ');
  if (!/^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/]{32,16384}={0,2}$/.test(row.hostKey)) {
    throw new Error('请粘贴已独立核实的完整主机公钥，例如 ssh-ed25519 AAAA…');
  }
  if (!['key', 'password'].includes(row.auth)) { throw new Error('SSH认证方式无效'); }
}
export class SSHHostStore {
  static binding(row: SSHHost): string { return JSON.stringify([row.id, row.host.toLowerCase(), row.port, row.username, row.hostKey, row.auth]); }
  static list(context: common.Context): SSHHost[] {
    const file = new AtomicTextFile(); const raw = file.read(context.filesDir + '/ssh-hosts.json');
    const rows = raw ? JSON.parse(raw) as SSHHost[] : [];
    if (!Array.isArray(rows)) { throw new Error('SSH配置格式损坏'); }
    rows.forEach((row: SSHHost) => { validateSSHHost(row); });
    return rows;
  }
  static async save(context: common.Context, value: SSHHost, credential: SSHCredential): Promise<void> {
    const file = new AtomicTextFile(); const path = context.filesDir + '/ssh-hosts.json'; const raw = file.read(path);
    const rows = raw ? JSON.parse(raw) as SSHHost[] : [];
    const row = JSON.parse(JSON.stringify(value)) as SSHHost;
    if (!row.id) { row.id = util.generateRandomUUID(true); }
    validateSSHHost(row);
    const old = rows.find((item: SSHHost) => item.id === row.id);
    if (row.auth === 'key' ? credential.privateKey.length > 0 : credential.password.length > 0) {
      if (credential.privateKey.length > 65536 || credential.passphrase.length > 4096 || credential.password.length > 4096 ||
        [credential.privateKey, credential.passphrase, credential.password].some((text: string) => text.includes('\u0000'))) {
        throw new Error('SSH凭据过长或含非法字符');
      }
      if (row.auth === 'key' && !credential.privateKey.includes('PRIVATE KEY-----')) { throw new Error('请选择有效的SSH私钥文件'); }
      row.secretRef = await BoundSecret.stage(SSHHostStore.binding(row), JSON.stringify(credential));
    } else if (!old || SSHHostStore.binding(old) !== SSHHostStore.binding(row)) { throw new Error('新连接或更改目标时请重新提供凭据'); }
    else { row.secretRef = old.secretRef; }
    file.write(path, JSON.stringify(rows.filter((item: SSHHost) => item.id !== row.id).concat([row])));
    if (old && old.secretRef !== row.secretRef) { await BoundSecret.retire(old.secretRef); }
  }
  static async credential(row: SSHHost): Promise<SSHCredential> {
    const value = await BoundSecret.read(row.secretRef, SSHHostStore.binding(row));
    if (!value) { throw new Error('SSH凭据不可用，请重新导入'); }
    return JSON.parse(value) as SSHCredential;
  }
  static async remove(context: common.Context, id: string): Promise<void> {
    const file = new AtomicTextFile(); const path = context.filesDir + '/ssh-hosts.json'; const raw = file.read(path);
    const rows = raw ? JSON.parse(raw) as SSHHost[] : [];
    const old = rows.find((row: SSHHost) => row.id === id);
    file.write(path, JSON.stringify(rows.filter((row: SSHHost) => row.id !== id)));
    if (old) { await BoundSecret.retire(old.secretRef); }
  }
}
