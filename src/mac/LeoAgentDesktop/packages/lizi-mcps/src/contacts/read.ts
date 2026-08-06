/**
 * contacts/read.ts — read 类工具: contacts_get / contacts_list /
 * contacts_list_groups / contacts_stats。
 *
 * compactProfile: resolve/list 场景的人物卡瘦身(事件流截断到最近 10 条 +
 * 总数标注), 全量档案只在 contacts_get 返回 — token economy。
 */

import { z } from 'zod';

import { withContacts } from './_shared.js';
import type { ContactsMcpDeps } from '../types.js';
import type { ContactsToolRegistry } from '../cindy_contactsToolRegistry.js';
import type { ContactProfile } from '@cindy/maker-core';

const RECENT_EVENTS_LIMIT = 10;

/** 人物卡瘦身: 事件截断 + 标注总数; identity 保留全部(反查是核心价值, 不截) */
export function compactProfile(p: ContactProfile): Record<string, unknown> {
  return {
    id: p.id,
    kind: p.kind,
    displayName: p.displayName,
    aliases: p.aliases,
    summary: p.summary,
    narrative: p.narrative,
    agentNotes: p.agentNotes,
    status: p.status,
    identities: p.identities.map((i) => ({
      id: i.id,
      platform: i.platform,
      value: i.value,
      label: i.label,
      note: i.note,
    })),
    recentEvents: p.events.slice(0, RECENT_EVENTS_LIMIT).map((e) => ({
      id: e.id,
      date: e.date,
      text: e.text,
      source: e.source,
    })),
    totalEvents: p.events.length,
    groups: p.groups.map((g) => ({ id: g.id, name: g.name })),
    relations: p.relations.map((r) => ({
      relationId: r.relationId,
      contactId: r.contactId,
      displayName: r.displayName,
      kind: r.kind,
      relation: r.relation,
      note: r.note,
      direction: r.direction,
    })),
    updatedAt: p.updatedAt,
  };
}

export function registerContactsGetTool(registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  registry.register({
    name: 'contacts_get',
    category: 'read',
    description:
      '按 id 读取完整档案: 全部身份映射、全量事件流(按日期倒序)、关系叙事、agentNotes、所属分组。' +
      'id 来自 contacts_resolve / contacts_search / contacts_list 的返回。',
    inputShape: {
      id: z.string().min(1),
    },
    handler: async (args) => withContacts(deps, (store) => store.getContact(args.id as string)),
  });
}

export function registerContactsListTool(registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  registry.register({
    name: 'contacts_list',
    category: 'read',
    description:
      '分页列出通讯录条目(按 updatedAt 倒序的摘要行, 不含叙事/事件全文)。' +
      '可按 kind(person/org)、status(confirmed/pending)、group_id 过滤。浏览全册或查看待确认队列时用。',
    inputShape: {
      kind: z.enum(['person', 'org']).optional(),
      status: z.enum(['confirmed', 'pending']).optional(),
      group_id: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional().describe('默认 50'),
      offset: z.number().int().min(0).optional(),
    },
    handler: async (args) =>
      withContacts(deps, (store) =>
        store.listContacts({
          ...(args.kind ? { kind: args.kind as 'person' | 'org' } : {}),
          ...(args.status ? { status: args.status as 'confirmed' | 'pending' } : {}),
          ...(args.group_id ? { groupId: args.group_id as string } : {}),
          ...(args.limit !== undefined ? { limit: args.limit as number } : {}),
          ...(args.offset !== undefined ? { offset: args.offset as number } : {}),
        }),
      ),
  });
}

export function registerContactsListGroupsTool(registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  registry.register({
    name: 'contacts_list_groups',
    category: 'read',
    description: '列出全部分组(含成员数)。配合 contacts_list({group_id}) 看组内成员。',
    inputShape: {},
    handler: async () => withContacts(deps, (store) => store.listGroups()),
  });
}

export function registerContactsStatsTool(registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  registry.register({
    name: 'contacts_stats',
    category: 'read',
    description: '通讯录概览统计: 人数 / 组织数 / 待确认数 / 分组数。',
    inputShape: {},
    handler: async () => withContacts(deps, (store) => store.stats()),
  });
}
