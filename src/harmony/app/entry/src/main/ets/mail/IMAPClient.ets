import { MailTransport } from './MailTransport';
import { MailAccount } from './MailAccountStore';
import { mailBase64, mailDecode, mailboxDisplay, mailboxWire, mailQuote } from './MailWire';
import { util } from '@kit.ArkTS';

export class IMAPReply {
  lines: string[] = [];
  literals: Uint8Array[] = [];
}
export class IMAPFolder {
  name: string = '';
  attributes: string = '';
}
export class IMAPMessage {
  text: string = '';
  flags: string[] = [];
  size: number = 0;
}
export class IMAPClient {
  private stream: MailTransport = new MailTransport();
  private sequence: number = 0;
  private capabilities: string = '';
  uidValidity: number = 0;

  async open(account: MailAccount, secret: string): Promise<void> {
    await this.stream.connect(account.imapHost, account.imapPort);
    const greeting = await this.stream.line();
    if (!/^\* (OK|PREAUTH)\b/i.test(greeting)) { throw new Error('IMAP 服务器未就绪'); }
    if (!/^\* PREAUTH\b/i.test(greeting)) {
      if (account.auth === 'xoauth2') {
        await this.command('AUTHENTICATE XOAUTH2', true, mailBase64('user=' + account.username + '\x01auth=Bearer ' + secret + '\x01\x01'));
      } else { await this.command('LOGIN ' + mailQuote(account.username) + ' ' + mailQuote(secret), true); }
    }
    this.capabilities = (await this.command('CAPABILITY')).lines.join(' ').toUpperCase();
  }
  close(): void { this.stream.close(); }

  private async command(command: string, authentication: boolean = false, append: string = ''): Promise<IMAPReply> {
    const tag = 'L' + (++this.sequence);
    await this.stream.send(tag + ' ' + command + '\r\n', authentication);
    const reply = new IMAPReply();
    let size = 0;
    while (true) {
      const line = await this.stream.line();
      size += line.length;
      if (size > 4 * 1024 * 1024) { throw new Error('IMAP 响应过长'); }
      if (line.startsWith(tag + ' ')) {
        if (!new RegExp('^' + tag + ' OK\\b', 'i').test(line)) { throw new Error(authentication ? '邮箱认证失败，请检查授权码或 OAuth 令牌' : '邮件服务器拒绝了该操作'); }
        return reply;
      }
      if (line.startsWith('+')) {
        if (append) { await this.stream.send(append + '\r\n', authentication); append = ''; continue; }
        await this.stream.send('\r\n');
        continue;
      }
      reply.lines.push(line);
      const literal = /\{(\d+)\}$/.exec(line);
      if (literal) { reply.literals.push(await this.stream.literal(Number(literal[1]))); }
    }
  }

  async folders(): Promise<IMAPFolder[]> {
    const response = await this.command('LIST "" "*"');
    const result: IMAPFolder[] = [];
    let literalIndex = 0;
    for (const line of response.lines) {
      const match = /^\* LIST \(([^)]*)\) (?:NIL|"(?:[^"\\]|\\.)*") (.+)$/i.exec(line);
      if (!match) { continue; }
      const row = new IMAPFolder(); row.attributes = match[1];
      const wireName = /^\{\d+\}$/.test(match[2]) && response.literals[literalIndex] ? mailDecode(response.literals[literalIndex++]) : match[2];
      row.name = mailboxDisplay(wireName.replace(/^"|"$/g, '').replace(/\\(["\\])/g, '$1'));
      result.push(row);
    }
    return result;
  }
  async select(folder: string, writable: boolean = false): Promise<void> {
    const result = await this.command((writable ? 'SELECT ' : 'EXAMINE ') + mailQuote(mailboxWire(folder)));
    this.uidValidity = Number(/\[UIDVALIDITY (\d+)\]/i.exec(result.lines.join(' '))?.[1] ?? 0);
  }
  async search(criteria: string, limit: number): Promise<number[]> {
    const reply = await this.command('UID SEARCH ' + criteria);
    const line = reply.lines.find((value: string) => /^\* SEARCH(?: |$)/i.test(value)) ?? '';
    return line.replace(/^\* SEARCH\s*/i, '').split(/\s+/).map((value: string) => Number(value))
      .filter((value: number) => Number.isSafeInteger(value) && value > 0).sort((a: number, b: number) => b - a).slice(0, limit);
  }
  async read(uid: number, headersOnly: boolean = false): Promise<string> {
    if (!Number.isSafeInteger(uid) || uid <= 0) { throw new Error('邮件 UID 无效'); }
    return (await this.fetch(uid, headersOnly)).text;
  }
  async fetch(uid: number, headersOnly: boolean = false): Promise<IMAPMessage> {
    if (!Number.isSafeInteger(uid) || uid <= 0) { throw new Error('邮件 UID 无效'); }
    const reply = await this.command('UID FETCH ' + uid + (headersOnly ? ' (UID FLAGS RFC822.SIZE BODY.PEEK[HEADER])' : ' (UID FLAGS RFC822.SIZE BODY.PEEK[])'));
    if (!reply.literals.length) { throw new Error('邮件已移动或正文不可读取'); }
    const result = new IMAPMessage();
    result.text = mailDecode(reply.literals[0]);
    const metadata = reply.lines.join(' ');
    const flags = /FLAGS \(([^)]*)\)/i.exec(metadata);
    result.flags = flags ? flags[1].split(/\s+/).filter((value: string) => value.length > 0) : [];
    result.size = Number(/RFC822.SIZE (\d+)/i.exec(metadata)?.[1] ?? 0);
    return result;
  }

  async update(uids: string, action: string, target: string = ''): Promise<void> {
    if (!/^\d+(?:,\d+){0,49}$/.test(uids) || uids.split(',').some((value: string) => Number(value) <= 0)) { throw new Error('邮件 UID 列表无效'); }
    const flags: Record<string, string> = { 'mark_read': '+FLAGS.SILENT (\\Seen)', 'mark_unread': '-FLAGS.SILENT (\\Seen)',
      'flag': '+FLAGS.SILENT (\\Flagged)', 'unflag': '-FLAGS.SILENT (\\Flagged)' };
    if (flags[action]) { await this.command('UID STORE ' + uids + ' ' + flags[action]); return; }
    if (!['move', 'trash', 'archive'].includes(action) || !target) { throw new Error('请指定有效操作与目标文件夹'); }
    if (/\bMOVE\b/.test(this.capabilities)) {
      await this.command('UID MOVE ' + uids + ' ' + mailQuote(mailboxWire(target)));
      return;
    }
    if (!/\bUIDPLUS\b/.test(this.capabilities)) { throw new Error('该服务器未提供安全的 UID MOVE 或 UID EXPUNGE，原邮件已保留'); }
    await this.command('UID COPY ' + uids + ' ' + mailQuote(mailboxWire(target)));
    try {
      await this.command('UID STORE ' + uids + ' +FLAGS.SILENT (\\Deleted)');
      await this.command('UID EXPUNGE ' + uids);
    } catch (_err) { throw new Error('邮件已复制到目标文件夹，源邮件移动未完成，请检查后再操作'); }
  }
  async append(folder: string, message: string): Promise<void> {
    const bytes = new util.TextEncoder().encodeInto(message).byteLength;
    await this.command('APPEND ' + mailQuote(mailboxWire(folder)) + ' (\\Seen) {' + bytes + '}', false, message);
  }
}
