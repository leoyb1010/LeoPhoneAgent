/**
 * contacts/search.ts — search 类工具: contacts_resolve / contacts_search。
 *
 * contacts_resolve 是整个通讯录的核心场景: 任意平台标识 → 人物卡, 三级递降
 * (identity 精确 → 名字/别名精确 → FTS 兜底), matchType 表达置信度。
 * 返回的 profile 事件流截断到最近 10 条(token economy), 全量走 contacts_get。
 */

import { z } from 'zod';

import { withContacts } from './_shared.js';
import { compactProfile } from './read.js';
import type { ContactsMcpDeps } from '../types.js';
import type { ContactsToolRegistry } from '../cindy_contactsToolRegistry.js';

export function registerContactsResolveTool(registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  registry.register({
    name: 'contacts_resolve',
    category: 'search',
    description:
      '身份反查: 输入任意平台标识(邮箱/飞书 id/Slack id/GitHub handle/手机号/姓名/别名), 返回人物卡列表。' +
      '遇到陌生邮箱/id、要给某人发消息、需要确认"这是谁"时先调这个。' +
      'matchType 表示命中路径: identity(平台身份精确命中, 最可信) / name(姓名或别名精确命中) / fts(全文兜底, 需自行判断)。' +
      '返回 profile 含 agentNotes(处置指令)与最近事件; 全量档案用 contacts_get。无命中返回空数组。',
    inputShape: {
      value: z.string().min(1).describe('要反查的标识: 邮箱 / 平台 id / handle / 姓名 / 别名'),
      platform: z
        .string()
        .optional()
        .describe('限定平台(email/feishu/slack/github/gitlab/phone/x/wechat/...), 缺省跨平台匹配'),
      limit: z.number().int().min(1).max(20).optional().describe('默认 5'),
    },
    handler: async (args) =>
      withContacts(deps, (store) => {
        const hits = store.resolve(args.value as string, {
          ...(args.platform ? { platform: args.platform as string } : {}),
          ...(args.limit ? { limit: args.limit as number } : {}),
        });
        return hits.map((h) => ({
          matchType: h.matchType,
          ...(h.identity ? { matchedIdentity: { platform: h.identity.platform, value: h.identity.value, label: h.identity.label } } : {}),
          profile: compactProfile(h.profile),
        }));
      }),
  });
}

export function registerContactsSearchTool(registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  registry.register({
    name: 'contacts_search',
    category: 'search',
    description:
      '通讯录全文检索(FTS5, bm25 排序 + <mark> 高亮 snippet): 覆盖姓名/别名/身份值/简介/关系叙事/事件流。' +
      '按关键词找人("做支付的那个人"/"上次聊过 OTA 的")、按公司/项目找相关联系人时用。' +
      '命中后拿 contactId 调 contacts_get 看全量档案。',
    inputShape: {
      query: z.string().min(1),
      kind: z.enum(['person', 'org']).optional(),
      status: z.enum(['confirmed', 'pending']).optional(),
      limit: z.number().int().min(1).max(50).optional().describe('默认 10'),
    },
    handler: async (args) =>
      withContacts(deps, (store) =>
        store.search(args.query as string, {
          ...(args.kind ? { kind: args.kind as 'person' | 'org' } : {}),
          ...(args.status ? { status: args.status as 'confirmed' | 'pending' } : {}),
          ...(args.limit ? { limit: args.limit as number } : {}),
        }),
      ),
  });
}
