import { common } from '@kit.AbilityKit';
import { IMAPClient, IMAPFolder } from './IMAPClient';
import { MailAccount, mailAccountStore } from './MailAccountStore';
import { mailHeaders, mailQuote, mimeText } from './MailWire';

export class MailService {
  static async open(account: MailAccount, track: (client: IMAPClient) => void = () => {}): Promise<IMAPClient> {
    const client = new IMAPClient();
    track(client);
    try { await client.open(account, await mailAccountStore.credential(account)); return client; }
    catch (err) { client.close(); throw new Error(`${err}`); }
  }
  static async test(context: common.Context, id: string): Promise<string> {
    const account = await mailAccountStore.resolve(context, id);
    const client = await MailService.open(account);
    try { return `IMAP 登录成功，共 ${(await client.folders()).length} 个文件夹`; }
    finally { client.close(); }
  }
  static async specialFolder(client: IMAPClient, kind: string): Promise<string> {
    const folders = await client.folders();
    const flag = '\\' + kind;
    const names: Record<string, string[]> = { 'Drafts': ['drafts', '草稿箱', '草稿'], 'Sent': ['sent', 'sent messages', '已发送'],
      'Trash': ['trash', 'deleted messages', '已删除', '垃圾箱'], 'Archive': ['archive', 'all mail', '归档', '存档'] };
    const selected = folders.find((folder: IMAPFolder) => folder.attributes.toLowerCase().includes(flag.toLowerCase())) ??
      folders.find((folder: IMAPFolder) => (names[kind] ?? []).includes(folder.name.toLowerCase()));
    if (!selected) { throw new Error('找不到' + kind + '文件夹，请先检查邮箱文件夹设置'); }
    return selected.name;
  }
  static async search(account: MailAccount, args: Record<string, Object>, track: (client: IMAPClient) => void = () => {}): Promise<Record<string, Object>[]> {
    const client = await MailService.open(account, track);
    try {
      const folder = `${args['folder'] ?? 'INBOX'}`;
      await client.select(folder);
      const criteria: string[] = [];
      if (args['unread_only'] === true || args['unread_only'] === 'true') { criteria.push('UNSEEN'); }
      for (const key of ['from', 'subject', 'query']) {
        const value = `${args[key] ?? ''}`.trim();
        if (value) { criteria.push((key === 'query' ? 'TEXT' : key.toUpperCase()) + ' ' + mailQuote(value)); }
      }
      const since = `${args['since'] ?? ''}`;
      if (since) {
        const relative = /^(\d+)(h|d|w)$/.exec(since);
        const date = relative ? new Date(Date.now() - Number(relative[1]) * (relative[2] === 'h' ? 3600000 : relative[2] === 'd' ? 86400000 : 604800000)) : new Date(since);
        if (!Number.isFinite(date.getTime())) { throw new Error('邮件日期筛选无效'); }
        criteria.push('SINCE ' + date.getUTCDate() + '-' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getUTCMonth()] + '-' + date.getUTCFullYear());
      }
      const limit = Math.min(50, Math.max(1, Number(args['limit'] ?? 20) || 20));
      const ids = await client.search('CHARSET UTF-8 ' + (criteria.join(' ') || 'ALL'), limit);
      const rows: Record<string, Object>[] = [];
      for (const uid of ids) {
        const fetched = await client.fetch(uid, true);
        const headers = mailHeaders(fetched.text);
        const row: Record<string, Object> = { 'uid': uid, 'uid_validity': client.uidValidity, 'account': account.email, 'folder': folder,
          'from': headers['from'] ?? '', 'to': headers['to'] ?? '', 'subject': headers['subject'] ?? '', 'date': headers['date'] ?? '', 'unread': !fetched.flags.includes('\\Seen'), 'size': fetched.size };
        rows.push(row);
      }
      return rows;
    } finally { client.close(); }
  }
  static async read(account: MailAccount, args: Record<string, Object>, track: (client: IMAPClient) => void = () => {}): Promise<Record<string, Object>> {
    const client = await MailService.open(account, track);
    try {
      const folder = `${args['folder'] ?? 'INBOX'}`;
      await client.select(folder);
      const uid = Number(args['uid']);
      const raw = await client.read(uid);
      const headers = mailHeaders(raw);
      const maxChars = Math.min(50000, Math.max(500, Number(args['max_chars'] ?? 12000) || 12000));
      const text = mimeText(raw);
      const result: Record<string, Object> = { 'uid': uid, 'uid_validity': client.uidValidity, 'account': account.email, 'folder': folder,
        'subject': headers['subject'] ?? '', 'from': headers['from'] ?? '', 'to': headers['to'] ?? '',
        'date': headers['date'] ?? '', 'body': text.slice(0, maxChars), 'truncated': text.length > maxChars,
        'trust': 'untrusted_email_content' };
      return result;
    } finally { client.close(); }
  }
}
