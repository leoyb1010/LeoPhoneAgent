// Private-stage only. Exercises production ETS transport and the same native NAPI instance.
import { UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';
import { backupCopy, backupHex } from '../backup/BackupFiles';
import { fileIo } from '@kit.CoreFileKit';
import { LinuxRuntime } from '../local/LinuxRuntime';
import { McpStdio, McpStdioSpec } from '../local/McpStdio';
import * as nativeLinux from 'libleolinux.so';

class PressureCase {
  name: string = '';
  error: string = '';
  peakSlots: number = 0;
  peakTasks: number = 0;
  zeroWriteDelta: number = 0;
  finalSlots: number = -1;
  finalTasks: number = -1;
  closeMilliseconds: number = 0;
  passed: boolean = false;
}
class PressureReport {
  scope: string = 'production ETS -> production LinuxRuntime -> same native NAPI globals';
  success: boolean = false;
  cases: PressureCase[] = [];
  error: string = '';
  paths: Record<string, Object> = {};
  goldenFixture: string = 'leobot-native-preserve-fixture.txt';
  guestLinksPassed: boolean = false;
  guestLinkOutput: string = '';
  workspaceBefore: string = '';
  workspaceAfter: string = '';
}

export default class McpPressureProbeAbility extends UIAbility {
  private closed: boolean = false;
  private report: PressureReport = new PressureReport();

  onCreate(_want: Want): void {
    this.run().catch((error: Error) => {
      this.report.error = error.message; this.save(); this.status('失败 ' + error.message);
    });
  }
  onWindowStageCreate(stage: window.WindowStage): void { stage.loadContent('pages/McpPressureProbePage'); }
  onDestroy(): void { this.closed = true; McpStdio.closeAll(); }
  private status(value: string): void {
    AppStorage.setOrCreate('mcpPressureStatus', value);
    console.info('LEOBOT_MCP_NATIVE_PRESSURE ' + value);
  }
  private save(): void {
    const nativeLog = this.context.filesDir + '/mcp-native-initialize.log';
    if (fileIo.accessSync(nativeLog) && fileIo.lstatSync(nativeLog).size <= 1024 * 1024) {
      const log = fileIo.openSync(this.context.cacheDir + '/mcp-native-initialize.log',
        fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.NOFOLLOW);
      try { fileIo.writeSync(log.fd, fileIo.readTextSync(nativeLog)); fileIo.fsyncSync(log.fd); }
      finally { fileIo.closeSync(log); }
    }
    const output = fileIo.openSync(this.context.cacheDir + '/mcp-pressure-native.json',
      fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.NOFOLLOW);
    try { fileIo.writeSync(output.fd, JSON.stringify(this.report)); fileIo.fsyncSync(output.fd); }
    finally { fileIo.closeSync(output); }
  }
  private current(): boolean { return !this.closed; }
  private async pause(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve: () => void) => { setTimeout(resolve, milliseconds); });
  }
  private spec(label: string, burst: number): McpStdioSpec {
    const lines: string[] = [
      "padding=$(/bin/busybox head -c 32768 /dev/zero | /bin/busybox tr '\\000' x)",
      'while IFS= read -r line; do',
      '  identifier=${line#*\\"id\\":}',
      '  identifier=${identifier%%,*}',
      '  case "$line" in',
      "    *'\"method\":\"initialize\"'*) printf '{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"serverInfo\":{\"name\":\"pressure-fixture\",\"version\":\"1\"}}}\\n' \"$identifier\" ;;",
      "    *'\"method\":\"tools/list\"'*) printf '{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"tools\":[]}}\\n' \"$identifier\" ;;",
      "    *'\"method\":\"tools/call\"'*) break ;;",
      '  esac', 'done', 'n=0',
      burst > 0 ? 'while [ "$n" -lt ' + burst + ' ]; do' : 'while :; do',
      "  printf '{\"jsonrpc\":\"2.0\",\"id\":\"%s-%s\",\"method\":\"ping\"}\\n' \"$padding\" \"$n\"",
      '  n=$((n+1))', 'done',
      // After the flood starts the server never reads stdin. Keep a descendant for scope cleanup too.
      'while :; do /bin/busybox sleep 600; done'
    ];
    const spec = new McpStdioSpec(); spec.label = label; spec.command = '/bin/sh'; spec.args = ['-c', lines.join('\n')]; return spec;
  }
  private async waitZero(row: PressureCase, since: number): Promise<void> {
    for (let tick = 0; tick < 240; tick++) {
      const stats = nativeLinux.scopeCounts();
      if (stats.slots === 0 && stats.tasks === 0) {
        row.finalSlots = stats.slots; row.finalTasks = stats.tasks; row.closeMilliseconds = Date.now() - since; return;
      }
      await this.pause(50);
    }
    const stats = nativeLinux.scopeCounts(); row.finalSlots = stats.slots; row.finalTasks = stats.tasks;
    throw new Error('实际native取消未归零 slots=' + stats.slots + ' tasks=' + stats.tasks);
  }
  private async exercise(name: string, peers: number, burst: number): Promise<void> {
    const row = new PressureCase(); row.name = name; this.report.cases.push(row);
    this.status(name + ' 初始化真实guest MCP');
    const definitions: McpStdioSpec[] = [];
    const before = nativeLinux.scopeCounts();
    if (before.slots !== 0 || before.tasks !== 0) { throw new Error('前一case存在未释放native任务'); }
    const timer = setInterval(() => {
      const stats = nativeLinux.scopeCounts();
      row.peakSlots = Math.max(row.peakSlots, stats.slots); row.peakTasks = Math.max(row.peakTasks, stats.tasks);
    }, 20);
    let failed = false;
    try {
      for (let index = 0; index < peers; index++) {
        const spec = this.spec(name + '-' + index, burst); definitions.push(spec);
        await McpStdio.request(spec, 'tools/list', '{}', 15000, () => this.current());
      }
      this.status(name + ' 持续stdout请求且不读stdin');
      const requests: Promise<string>[] = definitions.map((spec: McpStdioSpec) =>
        McpStdio.request(spec, 'tools/call', '{"name":"flood","arguments":{}}', 60000, () => this.current()).then(
          () => { throw new Error('压力任务不应返回成功'); }, (error: Error) => error.message));
      row.error = await Promise.race(requests);
      failed = !row.error.includes('配额');
      if (failed) { throw new Error('未触发实际ETS配额 ' + row.error); }
    } finally {
      clearInterval(timer); const closed = Date.now(); McpStdio.closeAll();
      await this.waitZero(row, closed);
      row.zeroWriteDelta = nativeLinux.scopeCounts().zeroWrites - before.zeroWrites;
      row.passed = !failed && row.error.includes('配额') && row.peakSlots >= peers && row.peakTasks >= peers;
      this.save();
      this.status(name + ' slots=' + row.finalSlots + ' tasks=' + row.finalTasks + ' writeBackpressure=' + row.zeroWriteDelta);
    }
    if (!row.passed) { throw new Error('实际配额与native生命周期证据不完整'); }
  }
  private prepareGolden(): void {
    const root = this.context.filesDir + '/workspace';
    if (!fileIo.accessSync(root)) { fileIo.mkdirSync(root); }
    const path = root + '/' + this.report.goldenFixture;
    const payload = 'LEOBOT_OWN_NON_SENSITIVE_NATIVE_PRESERVATION_FIXTURE_V1\n';
    if (fileIo.accessSync(path)) {
      const stat = fileIo.lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 || fileIo.readTextSync(path) !== payload) { throw new Error('保留fixture同名文件不匹配，未覆盖'); }
      return;
    }
    const output = fileIo.openSync(path, fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.NOFOLLOW);
    try { fileIo.writeSync(output.fd, payload); fileIo.fsyncSync(output.fd); } finally { fileIo.closeSync(output); }
  }

  private async probeGuestLinks(): Promise<void> {
    this.status('验证App虚拟bind符号链接、路径与离线npm bin');
    const script: string = [
      "set -eu",
      "base=$(/bin/busybox mktemp -d /mnt/workspace/.leobot-app-probe.XXXXXX)",
      "case \"$base\" in /mnt/workspace/.leobot-app-probe.*) ;; *) exit 61 ;; esac",
      "trap 'cd /; /bin/busybox rm -r -- \"$base\"; echo APP_LINK_TEMP_CLEANED' EXIT",
      "printf before > \"$base/original\"",
      "ln -s original \"$base/link\"",
      "test \"$(readlink \"$base/link\")\" = original",
      "cd \"$base\"; test \"$(cat link)\" = before",
      "printf after > link; test \"$(cat original)\" = after",
      "echo APP_GUEST_LINKS_OK",
      "test \"$(pwd -P)\" = \"$base\"",
      "exec 3<original; test \"$(readlink /proc/self/fd/3)\" = \"$base/original\"; exec 3<&-",
      "echo APP_GUEST_PATH_OK",
      "mkdir pkg app",
      "printf '%s' '{\"name\":\"leo-app-probe\",\"version\":\"1.0.0\",\"bin\":{\"leo-app-probe\":\"cli.js\"}}' > pkg/package.json",
      "printf '#!/usr/bin/env node\\nconsole.log(\"APP_NPM_BIN_OK\")\\n' > pkg/cli.js",
      "chmod 755 pkg/cli.js",
      "printf '%s' '{\"name\":\"leo-app-probe-consumer\",\"version\":\"1.0.0\",\"dependencies\":{\"leo-app-probe\":\"file:../pkg\"}}' > app/package.json",
      "cd app; npm install --offline --ignore-scripts --no-audit --no-fund",
      "test -L node_modules/.bin/leo-app-probe",
      "./node_modules/.bin/leo-app-probe"
    ].join('\n');
    const result = await LinuxRuntime.run(this.context, 'mcp-app-links-probe', script, 120000, () => this.current());
    this.report.guestLinkOutput = result.output.slice(-16000);
    this.report.guestLinksPassed = result.exitCode === 0 && ['APP_GUEST_LINKS_OK', 'APP_GUEST_PATH_OK', 'APP_NPM_BIN_OK', 'APP_LINK_TEMP_CLEANED'].every((marker: string) => result.output.includes(marker));
    this.save();
    if (!this.report.guestLinksPassed) { throw new Error('实际App guest符号链接/npm bin验证失败，输出已保存'); }
  }

  private async workspaceDigest(): Promise<string> {
    const root = this.context.filesDir + '/workspace';
    const digest = cryptoFramework.createMd('SHA256');
    const pending: string[] = ['']; let entries = 0;
    while (pending.length > 0) {
      if (++entries > 10000) { throw new Error('诊断工作区条目超过限额，压力未启动'); }
      const relative = pending.pop() ?? '';
      const path = relative ? root + '/' + relative : root;
      if (!fileIo.accessSync(path)) { continue; }
      const stat = fileIo.lstatSync(path);
      let identity = '';
      if (stat.isSymbolicLink()) { identity = 'symlink'; }
      else if (stat.isDirectory()) {
        const children = fileIo.listFileSync(path).sort();
        for (const child of children) { pending.push(relative ? relative + '/' + child : child); }
        if (relative) { identity = 'directory'; }
      } else if (stat.isFile()) { identity = (await backupCopy(path, '', () => this.current())).sha256; }
      else { identity = 'special-file'; }
      if (identity) { await digest.update({ data: new util.TextEncoder().encodeInto(JSON.stringify([relative, identity]) + '\n') }); }
    }
    return backupHex((await digest.digest()).data);
  }

  private async run(): Promise<void> {
    this.status('正在初始化真实本机Linux资源');
    this.report.paths = { 'filesDir': this.context.filesDir, 'workspace': this.context.filesDir + '/workspace', 'linuxRoot': this.context.filesDir + '/linux-alpine-v1' };
    const workspace = this.context.filesDir + '/workspace';
    if (fileIo.accessSync(workspace)) {
      const stat = fileIo.lstatSync(workspace); this.report.paths['workspaceIsDirectory'] = stat.isDirectory(); this.report.paths['workspaceIsSymlink'] = stat.isSymbolicLink();
    }
    this.prepareGolden();
    this.report.workspaceBefore = await this.workspaceDigest();
    await LinuxRuntime.initialize(this.context);
    await this.probeGuestLinks();
    McpStdio.attachContext(this.context);
    await this.exercise('per-server-128-frames', 1, 0);
    await this.exercise('global-256-frames', 3, 96);
    this.report.workspaceAfter = await this.workspaceDigest();
    if (this.report.workspaceBefore !== this.report.workspaceAfter) { throw new Error('诊断前后工作区内容哈希不一致'); }
    this.report.success = true; this.save(); this.status('PASS 真实ETS超限关闭后native slots/tasks均归零');
  }
}
