import { AppNavigation } from '../navigation/AppNavigation';
import { ActionButton } from '../theme/Controls';
import { common } from '@kit.AbilityKit';
import { fileIo, picker } from '@kit.CoreFileKit';
import { webview } from '@kit.ArkWeb';
import { util } from '@kit.ArkTS';
import { SSHRuntime } from '../local/SSHRuntime';
import { SSHCredential, SSHHost, SSHHostStore } from '../ssh/SSHHostStore';
import { SSHTerminalBridge } from '../ssh/SSHTerminalBridge';
import { NavBar } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

@Component
export struct SSHTerminalPage {
  @StorageProp('themeTick') themeTick: number = 0;
  @State hosts: SSHHost[] = [];
  @State editing: SSHHost = new SSHHost();
  @State secret: string = '';
  @State passphrase: string = '';
  @State keyName: string = '';
  @State status: string = '';
  @State busy: boolean = false;
  @State saving: boolean = false;
  @State connected: boolean = false;
  private privateKeyDraft: string = '';
  private owner: string = util.generateRandomUUID(true);
  private generation: number = 0;
  private timer: number = -1;
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: SSHTerminalBridge = new SSHTerminalBridge();

  aboutToAppear(): void {
    this.refresh(); this.bridge.owner = this.owner;
    this.bridge.onError = (message: string) => { this.status = message; };
  }
  aboutToDisappear(): void { this.disconnect(); this.privateKeyDraft = ''; this.secret = ''; this.passphrase = ''; }

  private refresh(): void {
    try { this.hosts = SSHHostStore.list(getContext(this)); } catch (_err) { this.status = 'SSH配置暂不可读取，原配置已保留'; }
  }
  build() {
    NavDestination() {
    Column() {
      NavBar({ title: 'SSH 终端' })
      if (!this.connected) {
        Scroll() {
          Column({ space: 10 }) {
            Text('主机公钥需要通过独立渠道核实。私钥仅保存在系统凭据库，认证在原生内存中完成。')
              .fontSize(13).fontColor(Tokens.secondary)
            ForEach(this.hosts, (host: SSHHost) => {
              Row({ space: 8 }) {
                ActionButton({ label: host.label || host.host, variant: 'secondary', fullWidth: false, busy: false, isEnabled: true, onTap: () => { this.editing = JSON.parse(JSON.stringify(host)) as SSHHost; this.privateKeyDraft = ''; this.keyName = ''; this.secret = ''; this.passphrase = ''; } }).layoutWeight(1)
                ActionButton({ label: '连接', variant: 'secondary', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => { this.connect(host); } })
                ActionButton({ label: '移除', variant: 'danger', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => {
                  AlertDialog.show({ title: '移除 SSH 连接', message: host.label || host.host,
                    confirm: { value: '移除', action: () => { SSHHostStore.remove(getContext(this), host.id).then(() => { this.refresh(); }).catch(() => { this.status = '移除失败'; }); } }, cancel: () => {} });
                } })
              }
            }, (host: SSHHost) => `${host.id}|${host.label}|${host.host}`)
            TextInput({ text: this.editing.label, placeholder: '连接名称' }).onChange((value: string) => { this.editing.label = value; })
            TextInput({ text: this.editing.host, placeholder: '主机域名或 IP' }).onChange((value: string) => { this.editing.host = value.trim(); })
            TextInput({ text: String(this.editing.port), placeholder: '端口，默认22' }).type(InputType.Number).onChange((value: string) => { this.editing.port = Number(value); })
            TextInput({ text: this.editing.username, placeholder: 'SSH用户名' }).onChange((value: string) => { this.editing.username = value.trim(); })
            TextArea({ text: this.editing.hostKey, placeholder: '已核实的主机公钥，ssh-ed25519 AAAA…' }).height(80)
              .onChange((value: string) => { this.editing.hostKey = value; })
            Row({ space: 10 }) {
              Text('使用私钥认证').fontColor(Tokens.text)
              Toggle({ type: ToggleType.Switch, isOn: this.editing.auth === 'key' }).onChange((value: boolean) => { this.editing.auth = value ? 'key' : 'password'; })
            }
            if (this.editing.auth === 'key') {
              ActionButton({ label: this.keyName ? '已选私钥 ' + this.keyName : '选择私钥文件', variant: 'secondary', fullWidth: false, busy: false, isEnabled: true, onTap: () => { this.pickKey(); } })
              TextInput({ text: this.passphrase, placeholder: '私钥口令（如有）' }).type(InputType.Password).onChange((value: string) => { this.passphrase = value; })
            } else {
              TextInput({ text: this.secret, placeholder: this.editing.id ? '留空保留原密码' : 'SSH密码' }).type(InputType.Password).onChange((value: string) => { this.secret = value; })
            }
            ActionButton({ label: '保存连接', variant: 'primary', fullWidth: true, busy: this.saving, isEnabled: !this.busy, onTap: () => { this.save(); } })
            ActionButton({ label: '添加另一连接', variant: 'secondary', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => { this.editing = new SSHHost(); this.privateKeyDraft = ''; this.keyName = ''; this.secret = ''; this.passphrase = ''; } })
          }.padding(20).width('100%').constraintSize({ maxWidth: 560 }).alignItems(HorizontalAlign.Start)
        }.constraintSize({ maxHeight: '65%' })
      }
      Row({ space: 10 }) {
        Text(this.status || '选择连接后打开交互终端').fontSize(13).fontColor(Tokens.muted).layoutWeight(1)
        if (this.connected || this.busy) { ActionButton({ label: '断开', variant: 'secondary', fullWidth: false, busy: false, isEnabled: true, onTap: () => { this.disconnect(); } }) }
      }.padding(10)
      Web({ src: $rawfile('terminal/terminal.html'), controller: this.controller })
        .javaScriptAccess(true).domStorageAccess(false).databaseAccess(false).fileAccess(false)
        .javaScriptProxy({ object: this.bridge, name: 'leoTerminal', methodList: ['postMessage'], controller: this.controller })
        .onOverrideUrlLoading((request) => { return request.getRequestUrl().split(/[?#]/)[0].toLowerCase() !== 'resource://rawfile/terminal/terminal.html'; })
        .onPermissionRequest((event) => { event?.request.deny(); })
        .layoutWeight(1)
    }.width('100%').height('100%').backgroundColor(Tokens.bg)

    }
    .hideTitleBar(true)
    .onShown(() => { AppNavigation.changed(); })
  }

  private async pickKey(): Promise<void> {
    try {
      const selected = await new picker.DocumentViewPicker(getContext(this) as common.UIAbilityContext).select({ maxSelectNumber: 1 });
      if (!selected.length) { return; }
      const file = fileIo.openSync(selected[0], fileIo.OpenMode.READ_ONLY);
      try {
        const size = fileIo.statSync(file.fd).size;
        if (size > 65536) { throw new Error('私钥文件超过64KB'); }
        const buffer = new ArrayBuffer(size);
        if (fileIo.readSync(file.fd, buffer) !== size) { throw new Error('私钥文件读取不完整'); }
        this.privateKeyDraft = util.TextDecoder.create('utf-8').decodeToString(new Uint8Array(buffer));
        this.keyName = '私钥文件';
      } finally { fileIo.closeSync(file); }
    } catch (_err) { this.status = '私钥读取失败，请选择有效的私钥文件'; }
  }
  private async save(): Promise<void> {
    this.busy = true; this.saving = true;
    try {
      const credential = new SSHCredential(); credential.privateKey = this.privateKeyDraft; credential.passphrase = this.passphrase; credential.password = this.secret;
      await SSHHostStore.save(getContext(this), this.editing, credential);
      credential.privateKey = ''; credential.passphrase = ''; credential.password = '';
      this.privateKeyDraft = ''; this.secret = ''; this.passphrase = ''; this.keyName = ''; this.editing = new SSHHost(); this.refresh(); this.status = 'SSH连接已保存';
    } catch (err) { this.status = `${err}`; } finally { this.busy = false; this.saving = false; }
  }
  private async connect(host: SSHHost): Promise<void> {
    this.disconnect(); const generation = this.generation; this.busy = true; this.status = '正在连接 ' + (host.label || host.host);
    try {
      await SSHRuntime.start(this.owner, host);
      if (generation !== this.generation) { return; }
      this.timer = setInterval(() => {
        try {
          const frame = SSHRuntime.poll(this.owner);
          this.busy = frame.state === 'connecting';
          this.connected = frame.state === 'connected'; this.bridge.enabled = this.connected;
          this.status = frame.error || (this.connected ? host.username + '@' + host.host + ' · ' + frame.fingerprint : frame.state === 'connecting' ? '正在建立加密连接' : '连接已结束');
          if (frame.text && this.bridge.ready) { this.controller.runJavaScript('window.leoTerminalOutput(' + JSON.stringify(frame.text) + ')').catch(() => {}); }
          if (['failed', 'exited', 'cancelled'].includes(frame.state)) { this.disconnect(false); }
        } catch (err) { this.status = `${err}`; this.disconnect(); }
      }, 80);
    } catch (err) { if (generation === this.generation) { this.status = `${err}`; this.busy = false; } }
  }
  private disconnect(stop: boolean = true): void {
    this.generation++; this.bridge.enabled = false; this.connected = false; this.busy = false;
    if (this.timer >= 0) { clearInterval(this.timer); this.timer = -1; }
    if (stop) { try { SSHRuntime.stop(this.owner); } catch (_err) {} }
  }
}
