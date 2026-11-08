import { UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { connection } from '@kit.NetworkKit';
import { fileIo } from '@kit.CoreFileKit';
import { LinuxRuntime } from '../local/LinuxRuntime';
import * as nativeLinux from 'libleolinux.so';
import { BusinessError } from '@kit.BasicServicesKit';

export default class DnsDiagnosticAbility extends UIAbility {
  onCreate(_want: Want): void { this.probe().catch(() => {}); }
  onWindowStageCreate(stage: window.WindowStage): void { stage.loadContent('pages/DnsDiagnosticPage'); }
  private async probe(): Promise<void> {
    const result: Record<string, Object> = { 'phase': 'default_network', 'sdkOk': false, 'dnsAddressCount': 0, 'errorCode': 0 };
    try {
      const network = await connection.getDefaultNet(); result['phase'] = 'connection_properties';
      const properties = await connection.getConnectionProperties(network);
      result['dnsAddressCount'] = properties.dnses.length; result['sdkOk'] = true;
    } catch (error) { result['errorCode'] = (error as BusinessError).code ?? -1; }
    const target = this.context.filesDir + '/linux-alpine-v1/data/etc/resolv.conf';
    result['target'] = '/etc/resolv.conf'; result['hostFileExists'] = fileIo.accessSync(target);
    try {
      const file = fileIo.openSync(target, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.NOFOLLOW);
      try { result['hostFileBytes'] = fileIo.statSync(file.fd).size; } finally { fileIo.closeSync(file); }
      result['hostOpenErrorCode'] = 0;
    } catch (error) { result['hostOpenErrorCode'] = (error as BusinessError).code ?? -1; }
    try {
      await LinuxRuntime.initialize(this.context);
      result['runtimePhase'] = LinuxRuntime.dnsStatus.phase; result['runtimeErrorCode'] = LinuxRuntime.dnsStatus.errorCode;
      result['runtimeExitCode'] = LinuxRuntime.dnsStatus.exitCode; result['runtimeServerCount'] = LinuxRuntime.dnsStatus.serverCount;
      const nodeScript = 'if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==="0")process.exit(91);const https=require("https");let timer;const req=https.get("https://example.org",res=>{clearTimeout(timer);console.log("NODE_HTTPS_STATUS="+res.statusCode+" TLS_AUTH="+res.socket.authorized);res.resume();});req.on("error",error=>{clearTimeout(timer);console.log("NODE_HTTPS_ERROR="+error.code);process.exitCode=1;});timer=setTimeout(()=>{console.log("NODE_HTTPS_TIMEOUT");req.destroy();process.exitCode=2;},20000);';
      const directory = fileIo.openSync(this.context.filesDir + '/workspace', fileIo.OpenMode.READ_ONLY | fileIo.OpenMode.DIR | fileIo.OpenMode.NOFOLLOW);
      const targetScript = this.context.filesDir + '/workspace/leobot-network-check.js';
      const created = nativeLinux.createWorkspaceFile(directory.fd, 'leobot-network-check.js'); fileIo.closeSync(directory);
      if (created >= 0) { try { fileIo.writeSync(created, nodeScript); fileIo.fsyncSync(created); } finally { fileIo.closeSync(created); } result['scriptCreated'] = true; }
      else if (created !== -17 || fileIo.lstatSync(targetScript).size > 8192 || fileIo.readTextSync(targetScript) !== nodeScript) { throw new Error('自有网络夹具同名文件不匹配，未覆盖'); }
      const command = "cat /etc/resolv.conf | /bin/busybox sed 's/^nameserver .*/nameserver [redacted]/'; curl --noproxy '*' --connect-timeout 10 --max-time 15 --silent --output /dev/null --write-out 'CURL_HTTP=%{http_code} TLS_VERIFY=%{ssl_verify_result}\\n' https://example.org 2>/dev/null; leo_dns_curl_exit=$?; printf 'CURL_EXIT=%s\\n' \"$leo_dns_curl_exit\"; node /mnt/workspace/leobot-network-check.js";
      const checked = await LinuxRuntime.run(this.context, 'dns-network-diagnostic', command, 45000);
      result['networkExit'] = checked.exitCode; result['networkOutput'] = checked.output;
    } catch (error) { result['runtimeFailureCode'] = (error as BusinessError).code ?? -1; }
    const output = fileIo.openSync(this.context.cacheDir + '/dns-diagnostic.json', fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.NOFOLLOW);
    try { fileIo.writeSync(output.fd, JSON.stringify(result)); fileIo.fsyncSync(output.fd); } finally { fileIo.closeSync(output); }
    AppStorage.setOrCreate('dnsDiagnostic', JSON.stringify(result));
    console.info('LEOBOT_DNS_DIAGNOSTIC ' + JSON.stringify(result));
  }
}
