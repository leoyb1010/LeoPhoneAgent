import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { AtomicTextFile } from '../store/AtomicFile';
import { BoundSecret } from '../store/BoundSecret';

export class MailAccount {
  id: string = '';
  label: string = '';
  email: string = '';
  username: string = '';
  imapHost: string = '';
  imapPort: number = 993;
  smtpHost: string = '';
  smtpPort: number = 465;
  smtpStartTLS: boolean = false;
  auth: string = 'password';
  secretRef: string = '';
  enabled: boolean = true;
}

export function validateMailAccount(row: MailAccount): void {
  const host = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
  if (!host.test(row.imapHost) || !host.test(row.smtpHost) || row.imapHost.includes('..') || row.smtpHost.includes('..')) {
    throw new Error('请填写邮件服务器域名');
  }
  if (!/^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[^\s<>@,;\r\n]+$/.test(row.email) ||
    /[\r\n\x00]/.test(row.username) || !row.username || row.username.length > 320) {
    throw new Error('邮箱地址或登录名无效');
  }
  for (const port of [row.imapPort, row.smtpPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) { throw new Error('邮件端口无效'); }
  }
  if (!['password', 'xoauth2'].includes(row.auth)) { throw new Error('认证类型无效'); }
}

export class MailAccountStore {
  rows: MailAccount[] = [];
  private file: AtomicTextFile = new AtomicTextFile();
  private path: string = '';
  private tail: Promise<void> = Promise.resolve();

  static binding(row: MailAccount): string {
    return JSON.stringify([row.id, row.email, row.username, row.imapHost.toLowerCase(), row.imapPort,
      row.smtpHost.toLowerCase(), row.smtpPort, row.smtpStartTLS, row.auth]);
  }

  async load(context: common.Context): Promise<void> {
    this.path = context.filesDir + '/mail-accounts.json';
    const raw = this.file.read(this.path);
    const rows = raw ? JSON.parse(raw) as MailAccount[] : [];
    if (!Array.isArray(rows)) { throw new Error('邮箱配置格式损坏，请恢复备份'); }
    rows.forEach((row: MailAccount) => { validateMailAccount(row); });
    this.rows = rows;
  }

  async save(context: common.Context, value: MailAccount, secret: string): Promise<void> {
    const run = this.tail.catch(() => {}).then(async () => {
      await this.load(context);
      const row = JSON.parse(JSON.stringify(value)) as MailAccount;
      if (!row.id) { row.id = util.generateRandomUUID(true); }
      validateMailAccount(row);
      const old = this.rows.find((item: MailAccount) => item.id === row.id);
      if (secret) {
        if (secret.length > 16384 || /[\r\n\x00\x01]/.test(secret)) { throw new Error('授权码或令牌格式无效'); }
        row.secretRef = await BoundSecret.stage(MailAccountStore.binding(row), secret);
      } else if (!old || MailAccountStore.binding(old) !== MailAccountStore.binding(row)) {
        throw new Error('更改服务器、账号或认证方式时请重新输入凭据');
      } else { row.secretRef = old.secretRef; }
      const next = this.rows.filter((item: MailAccount) => item.id !== row.id).concat([row]);
      this.file.write(this.path, JSON.stringify(next));
      this.rows = next;
      if (old && old.secretRef !== row.secretRef) { await BoundSecret.retire(old.secretRef); }
    });
    this.tail = run;
    return run;
  }

  async remove(context: common.Context, id: string): Promise<void> {
    const run = this.tail.catch(() => {}).then(async () => {
      await this.load(context);
      const old = this.rows.find((row: MailAccount) => row.id === id);
      const next = this.rows.filter((row: MailAccount) => row.id !== id);
      this.file.write(this.path, JSON.stringify(next));
      this.rows = next;
      if (old) { await BoundSecret.retire(old.secretRef); }
    });
    this.tail = run;
    return run;
  }

  async resolve(context: common.Context, name: string): Promise<MailAccount> {
    await this.load(context);
    const enabled = this.rows.filter((row: MailAccount) => row.enabled);
    const matches = name ? enabled.filter((row: MailAccount) =>
      [row.id, row.email, row.label].some((value: string) => value.toLowerCase() === name.toLowerCase())) : enabled;
    if (matches.length !== 1) { throw new Error('请指定一个已授权的邮箱'); }
    return JSON.parse(JSON.stringify(matches[0])) as MailAccount;
  }

  async credential(row: MailAccount): Promise<string> {
    const secret = await BoundSecret.read(row.secretRef, MailAccountStore.binding(row));
    if (!secret) { throw new Error('邮箱凭据不可用，请重新授权'); }
    return secret;
  }
}
export const mailAccountStore: MailAccountStore = new MailAccountStore();
