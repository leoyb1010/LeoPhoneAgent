// Included only by prepare_screen_probe.py in a private diagnostic HAP stage.
// No caller-supplied hostname, address, credential or URL is accepted.
import { util } from '@kit.ArkTS';
import { UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { connection } from '@kit.NetworkKit';
import { fileIo } from '@kit.CoreFileKit';
import { webview } from '@kit.ArkWeb';
import { gatewayStore } from '../store/GatewayStore';
import { MachinesClient } from '../net/MachinesClient';
import { RemoteWorkspaceLaunch } from '../remote/RemoteWorkspaceLaunch';
import { ScreenSessionRegistry } from '../remote/ScreenSessionBridge';

const FIXTURE_HOST: string = '__LEO_SCREEN_PROBE_HOST__';
const FIXTURE_ROOT: string = 'https://' + FIXTURE_HOST + ':18751';
const FIXTURE_MACHINE: string = 'HarmonyScreenFixture';

export default class ScreenSessionProbeAbility extends UIAbility {
  private preparing: Promise<void> = Promise.resolve();
  private closed: boolean = false;
  private revision: number = 0;
  private savedRoot: string = '';
  private savedKey: string = '';
  private savedMachine: string = '';
  private savedSession: string = '';
  private configured: boolean = false;

  onCreate(_want: Want): void {
    this.preparing = this.prepare();
    this.preparing.catch(() => {});
  }
  private async prepare(): Promise<void> {
    if (fileIo.accessSync(this.context.filesDir + '/restore-journal.json') || fileIo.accessSync(this.context.filesDir + '/restore-journal-v2.json')) { throw new Error('请先从正式入口完成备份恢复'); }
    this.probeDirectoryFd();
    await gatewayStore.ensureLoaded(this.context);
    if (this.closed) { return; }
    this.savedRoot = gatewayStore.apiRoot; this.savedKey = gatewayStore.key;
    this.savedMachine = RemoteWorkspaceLaunch.machine; this.savedSession = RemoteWorkspaceLaunch.sessionId;
    await connection.addCustomDnsRule(FIXTURE_HOST, ['10.0.2.2']);
    if (this.closed) { await connection.removeCustomDnsRule(FIXTURE_HOST); return; }
    const joined = await MachinesClient.join(FIXTURE_ROOT, 'HARMONY-SCREEN-TEST', 'Harmony ArkWeb screen fixture');
    if (this.closed) { await connection.removeCustomDnsRule(FIXTURE_HOST); return; }
    gatewayStore.apiRoot = FIXTURE_ROOT; gatewayStore.key = joined.accessKey;
    RemoteWorkspaceLaunch.machine = FIXTURE_MACHINE; RemoteWorkspaceLaunch.sessionId = '';
    this.configured = true;
    try { webview.WebviewController.initializeWebEngine(); } catch (_alreadyInitialized) {}
    AppStorage.setOrCreate('screenProbeError', '');
  }
  private probeDirectoryFd(): void {
    const directory = this.context.cacheDir + '/workspace-fd-probe-' + util.generateRandomUUID(false);
    let root: fileIo.File | null = null;
    let child: fileIo.File | null = null;
    let output: fileIo.File | null = null;
    let input: fileIo.File | null = null;
    const result: Record<string, Object> = { 'probe': 'own-cache-fixed-leaves', 'open': false, 'list': false, 'read': false, 'renameStable': false };
    try {
      fileIo.mkdirSync(directory);
      root = fileIo.openSync(directory, fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.DIR | fileIo.OpenMode.NOFOLLOW);
      const rootPath = '/proc/self/fd/' + root.fd;
      fileIo.mkdirSync(rootPath + '/child');
      child = fileIo.openSync(rootPath + '/child', fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.DIR | fileIo.OpenMode.NOFOLLOW);
      const childPath = '/proc/self/fd/' + child.fd;
      output = fileIo.openSync(childPath + '/payload.txt', fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.NOFOLLOW);
      const bytes = new util.TextEncoder().encodeInto('LEOBOT_OWN_CACHE_FD_PROBE');
      const count = fileIo.writeSync(output.fd, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      fileIo.fsyncSync(output.fd); fileIo.closeSync(output); output = null;
      input = fileIo.openSync(childPath + '/payload.txt', fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW);
      result['open'] = true;
      const buffer = new ArrayBuffer(bytes.byteLength);
      result['read'] = count === bytes.byteLength && fileIo.readSync(input.fd, buffer) === buffer.byteLength &&
        util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(new Uint8Array(buffer)) === 'LEOBOT_OWN_CACHE_FD_PROBE';
      fileIo.closeSync(input); input = null;
      result['list'] = fileIo.listFileSync(childPath).includes('payload.txt');
      fileIo.renameSync(directory + '/child', directory + '/child-moved');
      input = fileIo.openSync(childPath + '/payload.txt', fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.NOFOLLOW);
      result['renameStable'] = fileIo.statSync(input.fd).size === bytes.byteLength;
    } catch (error) { result['error'] = (error as Error).message; }
    finally {
      if (input) { fileIo.closeSync(input); }
      if (output) { fileIo.closeSync(output); }
      if (child) { fileIo.closeSync(child); }
      if (root) { fileIo.closeSync(root); }
      const report = fileIo.openSync(this.context.cacheDir + '/workspace-fd-probe.json', fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC | fileIo.OpenMode.NOFOLLOW);
      try { fileIo.writeSync(report.fd, JSON.stringify(result)); fileIo.fsyncSync(report.fd); } finally { fileIo.closeSync(report); }
      console.info('LEOBOT_WORKSPACE_FD_PROBE ' + JSON.stringify(result));
      if (fileIo.accessSync(directory)) { fileIo.rmdirSync(directory); }
    }
  }

  async onWindowStageCreate(stage: window.WindowStage): Promise<void> {
    try {
      await this.preparing;
      if (!this.closed) { await stage.loadContent('pages/ScreenSessionPage'); }
    } catch (error) {
      AppStorage.setOrCreate('screenProbeError', '诊断入口失败 ' + (error as Error).message);
      await connection.removeCustomDnsRule(FIXTURE_HOST).catch(() => {});
      if (!this.closed) { await stage.loadContent('pages/ScreenProbeStatusPage'); }
    }
  }
  onForeground(): void {
    const revision = ++this.revision;
    if (this.configured) {
      connection.addCustomDnsRule(FIXTURE_HOST, ['10.0.2.2']).then(() => {
        if (!this.closed && revision === this.revision) { ScreenSessionRegistry.resume(); }
      }).catch(() => { AppStorage.setOrCreate('screenProbeError', 'App作用域诊断DNS映射未恢复'); });
    }
  }
  onBackground(): void {
    const revision = ++this.revision;
    ScreenSessionRegistry.suspend().then(() => {
      if (revision === this.revision) { return connection.removeCustomDnsRule(FIXTURE_HOST); }
      return Promise.resolve();
    }).catch(() => {});
  }
  onDestroy(): void {
    this.closed = true; this.revision++;
    ScreenSessionRegistry.suspend().finally(() => {
      connection.removeCustomDnsRule(FIXTURE_HOST).catch(() => {});
      if (this.configured) {
        gatewayStore.apiRoot = this.savedRoot; gatewayStore.key = this.savedKey;
        RemoteWorkspaceLaunch.machine = this.savedMachine; RemoteWorkspaceLaunch.sessionId = this.savedSession;
      }
      this.savedKey = ''; this.configured = false;
    });
  }
}
