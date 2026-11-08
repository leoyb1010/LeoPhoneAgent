import { MailTransport } from './MailTransport';
import { MailAccount } from './MailAccountStore';
import { mailAddress, mailBase64 } from './MailWire';

export class SMTPClient {
  private stream: MailTransport = new MailTransport();
  private submitted: boolean = false;
  close(): void { this.stream.close(); }

  private async reply(expected: number[]): Promise<string> {
    const lines: string[] = [];
    for (let count = 0; count < 100; count++) {
      const line = await this.stream.line();
      if (!/^\d{3}[- ]/.test(line)) { throw new Error('SMTP 响应格式无效'); }
      lines.push(line);
      if (line[3] === ' ') {
        if (!expected.includes(Number(line.slice(0, 3)))) { throw new Error('SMTP 服务器拒绝了该步骤'); }
        return lines.join('\n');
      }
    }
    throw new Error('SMTP 响应过长');
  }
  private async command(text: string, codes: number[], authentication: boolean = false): Promise<string> {
    await this.stream.send(text + '\r\n', authentication);
    return await this.reply(codes);
  }
  async send(account: MailAccount, secret: string, recipients: string[], message: string): Promise<void> {
    recipients.forEach((value: string) => { mailAddress(value); });
    mailAddress(account.email);
    try {
      await this.stream.connect(account.smtpHost, account.smtpPort, !account.smtpStartTLS);
      await this.reply([220]);
      let extensions = await this.command('EHLO leobot.local', [250]);
      if (account.smtpStartTLS) {
        if (!/\bSTARTTLS\b/i.test(extensions)) { throw new Error('服务器未提供 STARTTLS，拒绝发送凭据'); }
        await this.command('STARTTLS', [220]);
        await this.stream.upgradeTLS(account.smtpHost, account.smtpPort);
        extensions = await this.command('EHLO leobot.local', [250]);
      }
      if (account.auth === 'xoauth2') {
        await this.command('AUTH XOAUTH2 ' + mailBase64('user=' + account.username + '\x01auth=Bearer ' + secret + '\x01\x01'), [235], true);
      } else if (/\bPLAIN\b/i.test(extensions)) {
        await this.command('AUTH PLAIN ' + mailBase64('\x00' + account.username + '\x00' + secret), [235], true);
      } else if (/\bLOGIN\b/i.test(extensions)) {
        await this.command('AUTH LOGIN', [334], true);
        await this.command(mailBase64(account.username), [334], true);
        await this.command(mailBase64(secret), [235], true);
      } else { throw new Error('服务器未提供支持的 SMTP 认证方式'); }
      await this.command('MAIL FROM:<' + account.email + '>', [250]);
      for (const recipient of recipients) { await this.command('RCPT TO:<' + recipient + '>', [250, 251]); }
      await this.command('DATA', [354]);
      this.submitted = true;
      await this.stream.send(message.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..') + '\r\n.\r\n');
      await this.reply([250]);
      this.submitted = false;
    } catch (err) {
      if (this.submitted) { throw new Error('邮件投递结果待确认，请先检查已发送文件夹，避免重复发送'); }
      throw new Error(`${err}`);
    } finally { this.stream.close(); }
  }
}
