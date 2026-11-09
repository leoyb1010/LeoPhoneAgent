import { AppNavigation } from '../navigation/AppNavigation';
import { ActionButton } from '../theme/Controls';
import { common } from '@kit.AbilityKit';
import { mailAccountStore, MailAccount } from '../mail/MailAccountStore';
import { MailService } from '../mail/MailService';
import { NavBar } from '../theme/Widgets';
import { Tokens } from '../theme/Tokens';

@Component
export struct MailAccountsPage {
  @StorageProp('themeTick') themeTick: number = 0;
  @State accounts: MailAccount[] = [];
  @State editing: MailAccount = new MailAccount();
  @State password: string = '';
  @State message: string = '';
  @State busy: boolean = false;
  @State operation: string = '';

  aboutToAppear(): void { this.refresh(); }
  private async refresh(): Promise<void> {
    try { await mailAccountStore.load(getContext(this)); this.accounts = mailAccountStore.rows.slice(); }
    catch (_err) { this.message = '邮箱配置暂时无法读取，原配置已保留'; }
  }
  build() {
    NavDestination() {
    Column() {
      NavBar({ title: '邮箱账户' })
      Scroll() {
        Column({ space: 14 }) {
          Text('邮件由本机通过 TLS 连接邮箱。请在服务商开启 IMAP/SMTP，并使用授权码或应用专用密码。')
            .fontSize(14).fontColor(Tokens.secondary)
          Text('OAuth 方式使用你已取得的访问令牌，过期后需更新。服务器证书和域名验证始终开启。')
            .fontSize(13).fontColor(Tokens.muted)
          ForEach(this.accounts, (account: MailAccount) => {
            Column({ space: 6 }) {
              Text(account.label || account.email).fontSize(18).fontWeight(FontWeight.Medium).fontColor(Tokens.text)
              Text(account.email + ' · ' + (account.enabled ? '已启用' : '已停用')).fontSize(13).fontColor(Tokens.muted)
              Flex({ wrap: FlexWrap.Wrap }) {
                ActionButton({ label: '编辑', variant: 'secondary', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => {
                  this.editing = JSON.parse(JSON.stringify(account)) as MailAccount; this.password = '';
                } })
                ActionButton({ label: '测试只读连接', variant: 'secondary', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => { this.test(account); } })
                ActionButton({ label: '移除', variant: 'danger', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => {
                  AlertDialog.show({ title: '移除邮箱授权', message: account.email,
                    confirm: { value: '移除', action: () => { this.remove(account.id); } }, cancel: () => {} });
                } })
              }
            }.width('100%').alignItems(HorizontalAlign.Start).padding(12).backgroundColor(Tokens.card).borderRadius(12)
          }, (account: MailAccount) => `${account.id}|${account.label}|${account.email}|${account.enabled}`)
          Divider()
          Text(this.editing.id ? '编辑邮箱' : '添加邮箱').fontSize(20).fontWeight(FontWeight.Bold).fontColor(Tokens.text)
          TextInput({ text: this.editing.label, placeholder: '名称，例如工作邮箱' }).onChange((value: string) => { this.editing.label = value; })
          TextInput({ text: this.editing.email, placeholder: '完整邮箱地址' }).onChange((value: string) => { this.editing.email = value; })
          TextInput({ text: this.editing.username, placeholder: '登录名，通常是邮箱地址' }).onChange((value: string) => { this.editing.username = value; })
          TextInput({ text: this.editing.imapHost, placeholder: 'IMAP 服务器，例如 imap.example.com' }).onChange((value: string) => { this.editing.imapHost = value.trim(); })
          TextInput({ text: String(this.editing.imapPort), placeholder: 'IMAP TLS 端口，通常 993' }).type(InputType.Number)
            .onChange((value: string) => { this.editing.imapPort = Number(value); })
          TextInput({ text: this.editing.smtpHost, placeholder: 'SMTP 服务器，例如 smtp.example.com' }).onChange((value: string) => { this.editing.smtpHost = value.trim(); })
          TextInput({ text: String(this.editing.smtpPort), placeholder: 'SMTP 端口，通常 465 或 587' }).type(InputType.Number)
            .onChange((value: string) => { this.editing.smtpPort = Number(value); })
          Row({ space: 10 }) {
            Text('SMTP 使用 STARTTLS（587）').fontSize(14).fontColor(Tokens.text)
            Toggle({ type: ToggleType.Switch, isOn: this.editing.smtpStartTLS }).onChange((value: boolean) => { this.editing.smtpStartTLS = value; })
          }
          Row({ space: 10 }) {
            Text('OAuth 访问令牌（XOAUTH2）').fontSize(14).fontColor(Tokens.text)
            Toggle({ type: ToggleType.Switch, isOn: this.editing.auth === 'xoauth2' })
              .onChange((value: boolean) => { this.editing.auth = value ? 'xoauth2' : 'password'; })
          }
          TextInput({ text: this.password, placeholder: this.editing.id ? '留空保留原凭据' : '授权码 / 应用专用密码 / OAuth 令牌' })
            .type(InputType.Password).onChange((value: string) => { this.password = value; })
          Row({ space: 10 }) {
            Text('启用邮箱工具').fontSize(14).fontColor(Tokens.text)
            Toggle({ type: ToggleType.Switch, isOn: this.editing.enabled }).onChange((value: boolean) => { this.editing.enabled = value; })
          }
          ActionButton({ label: '保存邮箱授权', variant: 'primary', fullWidth: true, busy: this.busy && this.operation === 'save', isEnabled: !this.busy, onTap: () => { this.save(); } })
          ActionButton({ label: '新建另一邮箱', variant: 'secondary', fullWidth: false, busy: false, isEnabled: !this.busy, onTap: () => { this.editing = new MailAccount(); this.password = ''; } })
          if (this.message) { Text(this.message).fontSize(14).fontColor(Tokens.warn).copyOption(CopyOptions.InApp) }
        }.width('100%').constraintSize({ maxWidth: 560 }).alignItems(HorizontalAlign.Start).padding({ left: 24, right: 24, top: 24, bottom: 40 })
      }.layoutWeight(1)
    }.width('100%').height('100%').backgroundColor(Tokens.grouped)

    }
    .hideTitleBar(true)
    .onShown(() => { AppNavigation.changed(); })
  }
  private async save(): Promise<void> {
    this.operation = 'save';
    this.busy = true;
    try {
      if (!this.editing.username) { this.editing.username = this.editing.email; }
      await mailAccountStore.save(getContext(this) as common.UIAbilityContext, this.editing, this.password);
      this.password = ''; this.editing = new MailAccount(); this.message = '邮箱授权已保存，建议测试只读连接'; await this.refresh();
    } catch (err) { this.message = `${err}`; } finally { this.busy = false; }
  }
  private async remove(id: string): Promise<void> {
    this.operation = 'remove';
    this.busy = true;
    try { await mailAccountStore.remove(getContext(this), id); await this.refresh(); this.message = '邮箱授权已移除'; }
    catch (err) { this.message = `${err}`; } finally { this.busy = false; }
  }
  private async test(account: MailAccount): Promise<void> {
    this.operation = 'test';
    this.busy = true;
    try { this.message = await MailService.test(getContext(this), account.id); }
    catch (_err) { this.message = '连接失败，请检查服务器、授权码、邮箱 IMAP 开关及网络'; }
    finally { this.busy = false; }
  }
}
