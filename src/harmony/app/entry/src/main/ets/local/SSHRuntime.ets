import { connection } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import * as nativeSSH from 'libleossh.so';
import { SSHHost, SSHHostStore, validateSSHHost } from '../ssh/SSHHostStore';

export class SSHFrame {
  text: string = '';
  state: string = '';
  error: string = '';
  fingerprint: string = '';
  exitCode: number = 0;
}
class SSHHandle {
  id: number = 0;
  token: string = '';
  decoder: util.TextDecoder = util.TextDecoder.create('utf-8', { ignoreBOM: true });
}
export class SSHRuntime {
  private static sequence: number = 0;
  private static epochs: Map<string, number> = new Map();
  private static handles: Map<string, SSHHandle> = new Map();

  static async start(owner: string, row: SSHHost): Promise<void> {
    if (!owner) { throw new Error('SSH窗口标识无效'); }
    validateSSHHost(row);
    SSHRuntime.stop(owner);
    const epoch = ++SSHRuntime.sequence;
    SSHRuntime.epochs.set(owner, epoch);
    let timeout: number = -1;
    try {
      const addresses = await Promise.race([
        connection.getAddressesByName(row.host),
        new Promise<connection.NetAddress[]>((_resolve, reject) => { timeout = setTimeout(() => { reject(new Error('SSH域名解析超时')); }, 15000); })
      ]);
      if (SSHRuntime.epochs.get(owner) !== epoch) { throw new Error('SSH连接已取消'); }
      const address = addresses.find((item: connection.NetAddress) => item.family === 1) ?? addresses[0];
      if (!address) { throw new Error('SSH地址无法解析'); }
      const credential = await SSHHostStore.credential(row);
      if (SSHRuntime.epochs.get(owner) !== epoch) { throw new Error('SSH连接已取消'); }
      const handle = new SSHHandle(); handle.token = util.generateRandomUUID(true);
      const options: nativeSSH.SSHConnectOptions = { owner: handle.token, host: address.address, port: row.port,
        username: row.username, hostKey: row.hostKey, privateKey: row.auth === 'key' ? credential.privateKey : '',
        passphrase: row.auth === 'key' ? credential.passphrase : '', password: row.auth === 'password' ? credential.password : '' };
      try { handle.id = nativeSSH.start(options); }
      finally { credential.privateKey = ''; credential.passphrase = ''; credential.password = ''; options.privateKey = ''; options.passphrase = ''; options.password = ''; }
      SSHRuntime.handles.set(owner, handle);
    } finally { if (timeout >= 0) { clearTimeout(timeout); } }
  }
  static poll(owner: string): SSHFrame {
    const handle = SSHRuntime.handles.get(owner);
    if (!handle) { throw new Error('SSH窗口没有连接'); }
    const result = nativeSSH.poll(handle.id, handle.token);
    const frame = new SSHFrame(); frame.state = result.state; frame.error = result.error; frame.fingerprint = result.fingerprint; frame.exitCode = result.exitCode;
    const finished = ['failed', 'exited', 'cancelled'].includes(result.state);
    frame.text = handle.decoder.decodeToString(new Uint8Array(result.buffer), { stream: !finished });
    if (result.truncated) { frame.text = '\r\n[终端输出过多，已保留末段]\r\n' + frame.text; }
    if (finished) { SSHRuntime.handles.delete(owner); }
    return frame;
  }
  static write(owner: string, text: string): void {
    const handle = SSHRuntime.handles.get(owner);
    if (!handle) { throw new Error('SSH窗口没有连接'); }
    const size = new util.TextEncoder().encodeInto(text).byteLength;
    if (size > 4096) { throw new Error('单次SSH输入最多4096字节'); }
    if (nativeSSH.write(handle.id, handle.token, text) !== size) { throw new Error('SSH输入尚未完整接受，请检查后重试'); }
  }
  static resize(owner: string, columns: number, rows: number): void {
    const handle = SSHRuntime.handles.get(owner);
    if (handle) { nativeSSH.resize(handle.id, handle.token, columns, rows); }
  }
  static stop(owner: string): void {
    SSHRuntime.epochs.delete(owner);
    const handle = SSHRuntime.handles.get(owner);
    if (handle) {
      SSHRuntime.handles.delete(owner);
      try { nativeSSH.stop(handle.id, handle.token); } catch (_err) {
        // The final poll may already have consumed this owner's completed native handle.
      }
    }
  }
  static stopAll(): void { Array.from(SSHRuntime.epochs.keys()).forEach((owner: string) => { SSHRuntime.stop(owner); }); }
}
