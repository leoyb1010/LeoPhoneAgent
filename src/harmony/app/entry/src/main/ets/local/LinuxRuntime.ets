import { BusinessError } from '@kit.BasicServicesKit';
import { common } from '@kit.AbilityKit';
import { connection } from '@kit.NetworkKit';
import { fileIo } from '@kit.CoreFileKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';
import { atomicWriteText } from '../store/AtomicFile';
import * as nativeLinux from 'libleolinux.so';

export class LinuxOutput {
  text: string = '';
  stderr: string = '';
  stderrTruncated: boolean = false;
  exited: boolean = false;
  exitCode: number = 0;
  truncated: boolean = false;
}
export class LinuxRunResult {
  pid: number = 0;
  output: string = '';
  exitCode: number = 0;
  truncated: boolean = false;
}
export class LinuxDNSStatus {
  phase: string = '';
  serverCount: number = 0;
  errorCode: number = 0;
  exitCode: number = -1;
  target: string = '/etc/resolv.conf';
}

/** Fixed guest path. Nameserver values are validated before entering this internal shell command. */
export function guestDNSWriteScript(servers: string[]): string {
  if (!servers.length || servers.length > 3 || servers.some((address: string) => !/^[0-9A-Fa-f:.]{1,64}$/.test(address))) {
    throw new Error('无效的当前网络DNS');
  }
  return [
    'set -eu',
    '[ -d /etc ] && [ ! -L /etc ] || exit 72',
    '[ ! -L /etc/resolv.conf ] || exit 73',
    'if [ -e /etc/resolv.conf ] && [ ! -f /etc/resolv.conf ]; then exit 74; fi',
    'leo_dns_tmp=$(/bin/busybox mktemp /etc/.leobot-resolv.XXXXXX)',
    "trap '[ -z \"$leo_dns_tmp\" ] || /bin/busybox rm -- \"$leo_dns_tmp\"' EXIT",
    "printf '%s\\n' " + servers.map((address: string) => "'nameserver " + address + "'").join(' ') + ' > "$leo_dns_tmp"',
    '/bin/busybox chmod 644 "$leo_dns_tmp"',
    '/bin/busybox sync "$leo_dns_tmp"',
    '[ ! -L /etc/resolv.conf ] || exit 73',
    'if [ -e /etc/resolv.conf ] && [ ! -f /etc/resolv.conf ]; then exit 74; fi',
    // -T replaces the directory entry itself even if it is swapped after the guard, never follows a destination link.
    '/bin/busybox mv -T -- "$leo_dns_tmp" /etc/resolv.conf',
    "leo_dns_tmp=''; trap - EXIT",
    '/bin/busybox sync /etc',
    'printf LEO_GUEST_DNS_WRITE_OK'
  ].join('\n');
}

/** This module drives the bundled iSH ARM64 interpreter, not host process execution. */
export class LinuxRuntime {
  private static starting: Promise<void> | undefined = undefined;
  private static decoders: Map<number, util.TextDecoder> = new Map();
  private static stderrDecoders: Map<number, util.TextDecoder> = new Map();
  private static owners: Map<number, string> = new Map();
  private static root: string = '';
  static ready: boolean = false;
  static networkStatus: string = '';
  static dnsStatus: LinuxDNSStatus = new LinuxDNSStatus();
  static async initialize(context: common.Context): Promise<void> {
    if (LinuxRuntime.ready) return;
    if (LinuxRuntime.starting) return LinuxRuntime.starting;
    LinuxRuntime.starting = LinuxRuntime.install(context).finally(() => LinuxRuntime.starting = undefined);
    return LinuxRuntime.starting;
  }
  private static async verifiedResource(context: common.Context, name: string, expected: string): Promise<string> {
    const bytes = await context.resourceManager.getRawFileContent(name);
    const digest = cryptoFramework.createMd('SHA256');
    await digest.update({ data: bytes });
    let actual = '';
    for (const byte of (await digest.digest()).data) actual += byte.toString(16).padStart(2, '0');
    if (actual !== expected) throw new Error('Linux安装资源校验失败，请重新安装完整版本');
    const path = context.cacheDir + '/' + name;
    const file = fileIo.openSync(path, fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC |
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.NOFOLLOW);
    try {
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      if (await fileIo.write(file.fd, buffer) !== bytes.byteLength) throw new Error('Linux安装资源写入不完整');
      await fileIo.fsync(file.fd);
    } finally { await fileIo.close(file); }
    return path;
  }
  private static async install(context: common.Context): Promise<void> {
    AppStorage.setOrCreate('linuxStage', '正在校验本机 Linux 资源');
    const pack = await LinuxRuntime.verifiedResource(context, 'linux-rootfs.pack', nativeLinux.packHash());
    const workspace = context.filesDir + '/workspace';
    if (!fileIo.accessSync(workspace)) fileIo.mkdirSync(workspace);
    LinuxRuntime.root = context.filesDir + '/linux-alpine-v1';
    try {
      await nativeLinux.initialize(LinuxRuntime.root, pack, workspace);
      await LinuxRuntime.refreshDNS();
      await LinuxRuntime.bootstrap(context);
      LinuxRuntime.ready = true;
      AppStorage.setOrCreate('linuxStage', '本机 Linux 已就绪');
    } finally {
      try { fileIo.unlinkSync(pack); } catch (_error) { }
    }
  }
  private static async bootstrap(context: common.Context): Promise<void> {
    const hash = nativeLinux.packagesHash();
    const prefix = context.filesDir + '/linux-bootstrap-' + hash.substring(0, 12);
    const marker = prefix + '.done';
    const installed = fileIo.accessSync(marker) && fileIo.readTextSync(marker) === hash;
    AppStorage.setOrCreate('linuxStage', '正在准备 Python、Node、Git 与命令行工具');
    const pack = await LinuxRuntime.verifiedResource(context, 'linux-packages.pack', hash);
    let pid = 0;
    let finished = false;
    try {
      // Bind tables are process-local. Restore the read-only constraint even when
      // the persistent package installation already succeeded in an earlier process.
      await nativeLinux.preparePackages(prefix, pack);
      if (installed) return;
      pid = nativeLinux.start('/bin/sh /mnt/bootstrap/install.sh', false);
      const decoder = util.TextDecoder.create('utf-8', { ignoreBOM: true });
      const deadline = Date.now() + 5 * 60 * 1000;
      let stopping = false;
      let transcript = '';
      for (;;) {
        const output = nativeLinux.poll(pid);
        transcript = (transcript + decoder.decodeToString(new Uint8Array(output.buffer), { stream: !output.exited })).slice(-16000);
        const steps = transcript.match(/\(\d+\/\d+\) (?:Installing|Upgrading) [^\r\n(]+/g);
        let stage = steps && steps.length ? '正在安装离线工具 ' + steps[steps.length - 1] : '正在验证离线工具';
        if (transcript.indexOf('LEO_PYTHON_BOOTSTRAP_OK') >= 0) stage = '正在验证 Node 与命令行工具';
        if (AppStorage.get<string>('linuxStage') !== stage) AppStorage.setOrCreate('linuxStage', stage);
        if (output.exited) {
          finished = true;
          if (output.exitCode !== 0 || transcript.indexOf('LEO_LINUX_BOOTSTRAP_COMPLETE') < 0) {
            throw new Error('离线工具安装未完成，可重新打开重试。' + transcript.slice(-800));
          }
          atomicWriteText(marker, hash);
          return;
        }
        if (Date.now() > deadline && !stopping) {
          nativeLinux.stop(pid);
          stopping = true;
        }
        if (Date.now() > deadline + 10000) throw new Error('离线工具安装退出尚未确认，请重新打开应用核对');
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      if (pid > 0 && !finished) nativeLinux.stop(pid);
      try { fileIo.unlinkSync(pack); } catch (_error) { }
    }
  }
  static async refreshDNS(): Promise<void> {
    const diagnostic = new LinuxDNSStatus(); LinuxRuntime.dnsStatus = diagnostic;
    try {
      diagnostic.phase = 'default_network';
      const network = await connection.getDefaultNet();
      diagnostic.phase = 'connection_properties';
      const properties = await connection.getConnectionProperties(network);
      const servers = properties.dnses.map((address: connection.NetAddress) => address.address)
        .filter((address: string) => /^[0-9A-Fa-f:.]{1,64}$/.test(address)).slice(0, 3);
      diagnostic.serverCount = servers.length;
      if (!servers.length) { diagnostic.phase = 'no_dns'; LinuxRuntime.networkStatus = '当前网络没有提供可用DNS'; return; }
      diagnostic.phase = 'guest_write';
      await LinuxRuntime.writeGuestDNS(guestDNSWriteScript(servers), diagnostic);
      diagnostic.phase = 'ready'; LinuxRuntime.networkStatus = '使用当前网络的DNS';
    } catch (error) {
      diagnostic.errorCode = (error as BusinessError).code ?? -1;
      LinuxRuntime.networkStatus = diagnostic.phase === 'guest_write' ? '当前网络DNS未同步，联网命令可能失败' : '当前网络DNS读取失败，联网命令可能失败';
    } finally {
      // Addresses remain in process memory. Diagnostics contain only phase, counts and error codes.
      console.info('LEOBOT_LINUX_DNS_STATUS ' + JSON.stringify(diagnostic));
    }
  }
  private static async writeGuestDNS(script: string, diagnostic: LinuxDNSStatus): Promise<void> {
    let pid = 0; let finished = false; let stopping = false;
    try {
      // Initialization has mounted the guest but has not set ready yet, just as during offline bootstrap.
      pid = nativeLinux.start(script, false);
      if (pid <= 0) { throw new Error('DNS配置进程未启动'); }
      const decoder = util.TextDecoder.create('utf-8', { ignoreBOM: true });
      const deadline = Date.now() + 10000; let transcript = '';
      for (;;) {
        const output = nativeLinux.poll(pid);
        transcript = (transcript + decoder.decodeToString(new Uint8Array(output.buffer), { stream: !output.exited })).slice(-1024);
        if (output.exited) {
          finished = true; diagnostic.exitCode = output.exitCode;
          if (output.exitCode !== 0 || output.truncated || !transcript.includes('LEO_GUEST_DNS_WRITE_OK')) { throw new Error('Guest DNS写入未确认'); }
          return;
        }
        if (Date.now() > deadline && !stopping) { nativeLinux.stop(pid); stopping = true; }
        if (Date.now() > deadline + 10000) { throw new Error('Guest DNS写入退出未确认'); }
        await new Promise<void>((resolve: () => void) => { setTimeout(resolve, 100); });
      }
    } finally { if (pid > 0 && !finished && !stopping) { nativeLinux.stop(pid); } }
  }
  static start(owner: string, command: string, interactive: boolean = false): number {
    return LinuxRuntime.startProcess(owner, command, interactive, false);
  }
  static startStdio(owner: string, command: string): number {
    return LinuxRuntime.startProcess(owner, command, false, true);
  }
  private static startProcess(owner: string, command: string, interactive: boolean, stdio: boolean): number {
    if (!LinuxRuntime.ready) throw new Error('Linux尚未初始化');
    if (!owner || command.length > 32768 || command.includes('\u0000')) throw new Error('会话或命令无效');
    const pid = stdio ? nativeLinux.startStdio(command) : nativeLinux.start(command, interactive);
    LinuxRuntime.owners.set(pid, owner);
    LinuxRuntime.decoders.set(pid, util.TextDecoder.create('utf-8', { ignoreBOM: true }));
    LinuxRuntime.stderrDecoders.set(pid, util.TextDecoder.create('utf-8', { ignoreBOM: true }));
    return pid;
  }
  private static requireOwner(owner: string, pid: number): void {
    if (!owner || LinuxRuntime.owners.get(pid) !== owner) throw new Error('此Linux任务属于另一会话或已结束');
  }
  static poll(owner: string, pid: number): LinuxOutput {
    LinuxRuntime.requireOwner(owner, pid);
    const result = nativeLinux.poll(pid);
    const output = new LinuxOutput(); output.exited = result.exited; output.exitCode = result.exitCode; output.truncated = result.truncated;
    const decoder = LinuxRuntime.decoders.get(pid);
    if (decoder) output.text = decoder.decodeToString(new Uint8Array(result.buffer), { stream: !result.exited });
    const stderrDecoder = LinuxRuntime.stderrDecoders.get(pid);
    if (stderrDecoder) output.stderr = stderrDecoder.decodeToString(new Uint8Array(result.stderrBuffer), { stream: !result.exited });
    output.stderrTruncated = result.stderrTruncated;
    if (result.exited) { LinuxRuntime.decoders.delete(pid); LinuxRuntime.stderrDecoders.delete(pid); LinuxRuntime.owners.delete(pid); }
    return output;
  }
  static write(owner: string, pid: number, text: string): void {
    LinuxRuntime.requireOwner(owner, pid);
    const size = new util.TextEncoder().encodeInto(text).byteLength;
    if (size > 4096) throw new Error('单次终端输入最多4096字节，长脚本请保存文件后执行');
    const written = nativeLinux.write(pid, text);
    if (written < 0) throw new Error('终端输入尚未写入，请稍后重试');
    if (written !== size) throw new Error(`终端仅接受${written}/${size}字节，请核对当前输入后再继续`);
  }
  static writeStdio(owner: string, pid: number, text: string): number {
    LinuxRuntime.requireOwner(owner, pid);
    const size = new util.TextEncoder().encodeInto(text).byteLength;
    if (size > 4096) throw new Error('单次stdio输入最多4096字节');
    const written = nativeLinux.write(pid, text);
    if (written < 0) throw new Error('stdio输入管道已关闭或写入失败');
    return written;
  }
  static resize(owner: string, pid: number, columns: number, rows: number): void {
    LinuxRuntime.requireOwner(owner, pid); nativeLinux.resize(pid, columns, rows);
  }
  static stop(owner: string, pid: number): void {
    LinuxRuntime.requireOwner(owner, pid); nativeLinux.stop(pid);
  }
  static async detach(owner: string, pid: number): Promise<void> {
    if (LinuxRuntime.owners.get(pid) !== owner) return;
    LinuxRuntime.stop(owner, pid);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (LinuxRuntime.owners.get(pid) !== owner) return;
      const output = LinuxRuntime.poll(owner, pid);
      if (output.exited) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Linux任务退出尚未确认');
  }
  static cancelOwner(owner: string): void {
    if (!owner) return;
    LinuxRuntime.owners.forEach((candidate: string, pid: number) => {
      if (candidate === owner) { try { nativeLinux.stop(pid); } catch (_error) { } }
    });
  }
  static async run(context: common.Context, owner: string, command: string, timeoutMs: number = 120000,
    isCurrent: () => boolean = () => true): Promise<LinuxRunResult> {
    await LinuxRuntime.initialize(context);
    if (!isCurrent()) throw new Error('Linux任务已取消');
    const result = new LinuxRunResult(); result.pid = LinuxRuntime.start(owner, command);
    const deadline = Date.now() + Math.max(1000, Math.min(timeoutMs, 10 * 60 * 1000));
    let stopping = false;
    for (;;) {
      const output = LinuxRuntime.poll(owner, result.pid);
      result.output += output.text;
      if (result.output.length > 1024 * 1024) { result.output = result.output.slice(-1024 * 1024); result.truncated = true; }
      result.truncated = result.truncated || output.truncated;
      if (output.exited) { result.exitCode = output.exitCode; return result; }
      if ((!isCurrent() || Date.now() > deadline) && !stopping) { LinuxRuntime.stop(owner, result.pid); stopping = true; }
      if (Date.now() > deadline + 10000) throw new Error('Linux任务停止回执未返回，请打开终端核对');
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
}
