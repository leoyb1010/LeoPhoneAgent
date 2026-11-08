import { common } from '@kit.AbilityKit';
import { notificationManager } from '@kit.NotificationKit';
import { util } from '@kit.ArkTS';
import { AtomicTextFile } from '../store/AtomicFile';
import { mailAccountStore } from './MailAccountStore';
import { IMAPClient } from './IMAPClient';
import { MailService } from './MailService';

export class MailWatchRule {
  id: string = '';
  name: string = '';
  account: string = '';
  from: string = '';
  subject: string = '';
  lastUid: number = 0;
  uidValidity: number = 0;
  checkedAt: number = 0;
}

/** Foreground/lifecycle polling. The system decides whether a background work request can run. */
export class MailWatch {
  private static busy: boolean = false;

  static list(context: common.Context): MailWatchRule[] {
    const file = new AtomicTextFile();
    const raw = file.read(context.filesDir + '/mail-watch.json');
    return raw ? JSON.parse(raw) as MailWatchRule[] : [];
  }

  static async configure(context: common.Context, args: Record<string, Object>, check: () => void = () => {}, track: (client: IMAPClient) => void = () => {}): Promise<string> {
    const file = new AtomicTextFile();
    const path = context.filesDir + '/mail-watch.json';
    const raw = file.read(path);
    const rules = raw ? JSON.parse(raw) as MailWatchRule[] : [];
    const action = `${args['action'] ?? 'list'}`;
    if (action === 'list') { return JSON.stringify(rules); }
    if (action === 'check_now') { return await MailWatch.check(context, true, check, track); }
    if (action === 'remove') {
      const name = `${args['name'] ?? ''}`;
      const next = rules.filter((rule: MailWatchRule) => rule.name !== name && rule.id !== name);
      if (next.length === rules.length) { throw new Error('没有这个邮件监控规则'); }
      check();
      file.write(path, JSON.stringify(next));
      return '邮件监控规则已移除';
    }
    if (action !== 'add') { throw new Error('邮件监控只支持 list/add/remove/check_now'); }
    if (rules.length >= 5) { throw new Error('最多 5 个邮件监控规则'); }
    const account = await mailAccountStore.resolve(context, `${args['account'] ?? ''}`);
    const rule = new MailWatchRule();
    rule.id = util.generateRandomUUID(true);
    rule.account = account.id;
    rule.name = `${args['name'] ?? ''}`.trim().slice(0, 100);
    rule.from = `${args['from_contains'] ?? ''}`.trim();
    rule.subject = `${args['subject_contains'] ?? ''}`.trim();
    if (!rule.name || rules.some((item: MailWatchRule) => item.name === rule.name)) { throw new Error('请使用一个新的监控规则名称'); }
    // Establish a baseline at creation so old matching mail does not trigger a false new-mail alert.
    const rows = await MailService.search(account, { 'folder': 'INBOX', 'limit': 1 }, track);
    rule.lastUid = rows.length ? Number(rows[0]['uid']) : 0;
    rule.uidValidity = rows.length ? Number(rows[0]['uid_validity']) : 0;
    rule.checkedAt = Date.now();
    check();
    file.write(path, JSON.stringify(rules.concat([rule])));
    return '监控已启用；App 回到前台时检查，后台检查由系统调度';
  }

  static async check(context: common.Context, force: boolean = false, check: () => void = () => {}, track: (client: IMAPClient) => void = () => {}): Promise<string> {
    if (MailWatch.busy) { return '邮件检查正在进行'; }
    MailWatch.busy = true;
    try {
      const file = new AtomicTextFile();
      const path = context.filesDir + '/mail-watch.json';
      const raw = file.read(path);
      const rules = raw ? JSON.parse(raw) as MailWatchRule[] : [];
      let notices = 0;
      for (const rule of rules) {
        if (!force && Date.now() - rule.checkedAt < 15 * 60 * 1000) { continue; }
        const account = await mailAccountStore.resolve(context, rule.account);
        const rows = await MailService.search(account, { 'folder': 'INBOX', 'limit': 50 }, track);
        const highest = rows.length ? Math.max(...rows.map((row: Record<string, Object>) => Number(row['uid']))) : rule.lastUid;
        const validity = rows.length ? Number(rows[0]['uid_validity']) : rule.uidValidity;
        const reset = rule.uidValidity > 0 && validity > 0 && rule.uidValidity !== validity;
        const fresh = reset ? [] : rows.filter((row: Record<string, Object>) => Number(row['uid']) > rule.lastUid &&
          (!rule.from || rule.from.split(',').some((term: string) => `${row['from'] ?? ''}`.toLowerCase().includes(term.trim().toLowerCase()))) &&
          (!rule.subject || rule.subject.split(',').some((term: string) => `${row['subject'] ?? ''}`.toLowerCase().includes(term.trim().toLowerCase()))));
        rule.lastUid = highest;
        rule.uidValidity = validity;
        check();
        rule.checkedAt = Date.now();
        // Claim before notification so process death cannot replay the same message alert indefinitely.
        file.write(path, JSON.stringify(rules));
        if (fresh.length > 0) {
          await notificationManager.publish({ id: 74000 + rules.indexOf(rule), content: {
            notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
            normal: { title: 'LeoBot 有新邮件', text: `规则「${rule.name}」匹配 ${fresh.length} 封新邮件，打开 App 查看` }
          } });
          notices++;
        }
      }
      return `邮件检查完成，${notices} 条规则发现新邮件`;
    } finally { MailWatch.busy = false; }
  }
}
