/**
 * contacts/write.ts — write 类工具(agent 日常自主可用):
 * contacts_create / contacts_update / contacts_add_identity /
 * contacts_remove_identity / contacts_append_event。
 *
 * 采集边界规则(CONTACTS_COLLECTION_RULES)挂在本类工具的 rules 字段 —
 * agent 首次 list_tools(category:"write") 时读一遍, 零 system prompt 改动。
 * source 由代码固定为 'agent'(规则 9: 用代码保证确定性, 不靠 LLM 自报)。
 */

import { z } from 'zod';

import { CONTACTS_COLLECTION_RULES, withContacts } from './_shared.js';
import { DuplicateSuspectSignal } from './errors.js';
import type { ContactsMcpDeps } from '../types.js';
import type { ContactsToolRegistry } from '../cindy_contactsToolRegistry.js';

const identityShape = {
  platform: z
    .string()
    .min(1)
    .max(32)
    .describe('平台标识(小写): email/feishu/slack/github/gitlab/phone/x/wechat/telegram/discord/...'),
  value: z.string().min(1).max(320).describe('身份值原文(邮箱地址/平台 id/handle/号码)'),
  label: z.string().max(60).optional().describe('标签, e.g. "当前" / "早期" / "个人"'),
  note: z.string().max(200).optional().describe('来源备注'),
};

export function registerContactsCreateTool(registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  registry.register({
    name: 'contacts_create',
    category: 'write',
    description:
      '新建人物或组织档案(可随建档挂身份)。**自带查重(代码保证)**: ' +
      '(1) 身份(邮箱/id)与已有档案精确相同 → 不新建, 自动把本次信息并入那份档案(返回 merged:true + enrich 明细); ' +
      '(2) 名字/别名与既有档案相似 → 拒绝并返回 DUPLICATE_SUSPECT + 候选列表, 先 contacts_get 确认: ' +
      '同人 → 改用 contacts_update / contacts_add_identity / contacts_append_event; 确认不同人 → 带 allow_duplicate:true 重试。' +
      '低置信信息用 status:"pending"(进用户待确认队列)。' +
      'narrative 是自由 markdown 的关系叙事; agent_notes 是给 agent 自己的处置指令(如"老板私人邮箱勿群发")。',
    rules: [CONTACTS_COLLECTION_RULES],
    inputShape: {
      kind: z.enum(['person', 'org']),
      display_name: z.string().min(1).max(100),
      aliases: z.array(z.string().min(1).max(100)).max(20).optional(),
      summary: z.string().max(300).optional().describe('一行简介'),
      narrative: z.string().optional().describe('关系叙事 markdown, ≤16KB'),
      agent_notes: z.string().max(1000).optional().describe('给 agent 的处置指令'),
      status: z.enum(['confirmed', 'pending']).optional().describe('低置信用 pending, 默认 confirmed'),
      identities: z.array(z.object(identityShape)).max(30).optional(),
      allow_duplicate: z
        .boolean()
        .optional()
        .describe('仅在收到 DUPLICATE_SUSPECT 且确认候选确实是不同人后传 true 强制新建'),
    },
    handler: async (args) =>
      withContacts(deps, (store) => {
        const input = {
          kind: args.kind as 'person' | 'org',
          displayName: args.display_name as string,
          ...(args.aliases ? { aliases: args.aliases as string[] } : {}),
          ...(args.summary !== undefined ? { summary: args.summary as string } : {}),
          ...(args.narrative !== undefined ? { narrative: args.narrative as string } : {}),
          ...(args.agent_notes !== undefined ? { agentNotes: args.agent_notes as string } : {}),
          ...(args.status ? { status: args.status as 'confirmed' | 'pending' } : {}),
          ...(args.identities
            ? {
                identities: (
                  args.identities as Array<{ platform: string; value: string; label?: string; note?: string }>
                ).map((i) => ({
                  platform: i.platform,
                  value: i.value,
                  ...(i.label !== undefined ? { label: i.label } : {}),
                  ...(i.note !== undefined ? { note: i.note } : {}),
                })),
              }
            : {}),
          source: 'agent' as const,
        };

        // 查重(规则 9: 代码保证, 不依赖 agent 自觉)
        const candidates = store.findSimilar(input);
        const identityHit = candidates.find((c) => c.matchType === 'identity');
        if (identityHit) {
          // 身份精确相同 = 同一个人: 自动并入既有档案, 绝不新建
          const enriched = store.enrichContact(identityHit.contactId, input);
          return {
            merged: true,
            mergedInto: { id: identityHit.contactId, displayName: identityHit.displayName },
            enrich: enriched,
            profile: store.getContact(identityHit.contactId),
            hint: '身份与已有档案相同, 已自动并入该档案(未新建)。后续更新直接用此 id。',
          };
        }
        const nameHits = candidates.filter((c) => c.matchType === 'name');
        if (nameHits.length > 0 && !(args.allow_duplicate as boolean | undefined)) {
          throw new DuplicateSuspectSignal(nameHits);
        }
        return { merged: false, profile: store.createContact(input) };
      }, { mutates: true }),
  });
}

export function registerContactsUpdateTool(registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  registry.register({
    name: 'contacts_update',
    category: 'write',
    description:
      '更新档案字段(patch 语义: 只更新显式给出的字段; aliases 整组替换)。' +
      '把 pending 档案转正用 status:"confirmed"; 公司被错建成人(或反之)用 kind 修正类型。' +
      '追加带日期的动态请优先用 contacts_append_event 而不是改写 narrative。',
    rules: [CONTACTS_COLLECTION_RULES],
    inputShape: {
      id: z.string().min(1),
      kind: z.enum(['person', 'org']).optional().describe('修正错档类型'),
      display_name: z.string().min(1).max(100).optional(),
      aliases: z.array(z.string().min(1).max(100)).max(20).optional(),
      summary: z.string().max(300).optional(),
      narrative: z.string().optional(),
      agent_notes: z.string().max(1000).optional(),
      status: z.enum(['confirmed', 'pending']).optional(),
    },
    handler: async (args) =>
      withContacts(deps, (store) =>
        store.updateContact(args.id as string, {
          ...(args.kind !== undefined ? { kind: args.kind as 'person' | 'org' } : {}),
          ...(args.display_name !== undefined ? { displayName: args.display_name as string } : {}),
          ...(args.aliases !== undefined ? { aliases: args.aliases as string[] } : {}),
          ...(args.summary !== undefined ? { summary: args.summary as string } : {}),
          ...(args.narrative !== undefined ? { narrative: args.narrative as string } : {}),
          ...(args.agent_notes !== undefined ? { agentNotes: args.agent_notes as string } : {}),
          ...(args.status !== undefined ? { status: args.status as 'confirmed' | 'pending' } : {}),
        }),
        { mutates: true },
      ),
  });
}

export function registerContactsAddIdentityTool(registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  registry.register({
    name: 'contacts_add_identity',
    category: 'write',
    description:
      '给已有档案追加一条平台身份(邮箱/id/handle)。发现"同一个人的新联系方式"时用。' +
      '(platform, value) 全局唯一: 已属他人返回 IDENTITY_CONFLICT + conflictContactId(考虑是否该 merge); ' +
      '已在本人名下返回 ALREADY_EXISTS(无需重复添加)。',
    rules: [CONTACTS_COLLECTION_RULES],
    inputShape: {
      contact_id: z.string().min(1),
      ...identityShape,
    },
    handler: async (args) =>
      withContacts(deps, (store) =>
        store.addIdentity(args.contact_id as string, {
          platform: args.platform as string,
          value: args.value as string,
          ...(args.label !== undefined ? { label: args.label as string } : {}),
          ...(args.note !== undefined ? { note: args.note as string } : {}),
        }),
        { mutates: true },
      ),
  });
}

export function registerContactsRemoveIdentityTool(registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  registry.register({
    name: 'contacts_remove_identity',
    category: 'write',
    description: '移除一条身份映射(identity_id 来自档案的 identities 列表)。确认某联系方式已失效/挂错人时用。',
    inputShape: {
      identity_id: z.string().min(1),
    },
    handler: async (args) =>
      withContacts(deps, (store) => {
        store.removeIdentity(args.identity_id as string);
        return { removed: true };
      }, { mutates: true }),
  });
}

export function registerContactsRelationTools(registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  registry.register({
    name: 'contacts_add_relation',
    category: 'write',
    description:
      '建立两个档案间的有向关系 from --relation--> to: 典型如 人--任职-->组织(note 填职位)、' +
      '人--家人/介绍人-->人、组织--子公司-->组织。关系双向可见(对端档案以反向呈现), ' +
      '并进入检索(搜组织名可找到成员)。发现"某人属于某公司/团队"时优先用这个, 不要只写进叙事。',
    rules: [CONTACTS_COLLECTION_RULES],
    inputShape: {
      from_id: z.string().min(1).describe('关系发起端 contact id(任职关系填人)'),
      to_id: z.string().min(1).describe('关系指向端 contact id(任职关系填组织)'),
      relation: z.string().min(1).max(30).describe('关系动词, e.g. "任职" / "成员" / "家人" / "介绍人"'),
      note: z.string().max(200).optional().describe('补充说明, e.g. 职位'),
    },
    handler: async (args) =>
      withContacts(deps, (store) =>
        store.addRelation(args.from_id as string, {
          toId: args.to_id as string,
          relation: args.relation as string,
          ...(args.note !== undefined ? { note: args.note as string } : {}),
        }),
        { mutates: true },
      ),
  });

  registry.register({
    name: 'contacts_remove_relation',
    category: 'write',
    description: '移除一条关系边(relation_id 来自档案的 relations 列表)。关系已失效/挂错时用。',
    inputShape: {
      relation_id: z.string().min(1),
    },
    handler: async (args) =>
      withContacts(deps, (store) => {
        store.removeRelation(args.relation_id as string);
        return { removed: true };
      }, { mutates: true }),
  });
}

export function registerContactsAppendEventTool(registry: ContactsToolRegistry, deps: ContactsMcpDeps): void {
  registry.register({
    name: 'contacts_append_event',
    category: 'write',
    description:
      '给档案追加一条带日期的事件(append-only 事件流): 职位变动/项目协作/重要往来/联系方式变更等。' +
      '这是记录"随时间变化的信息"的首选方式 — 不要用改写 narrative 的方式覆盖旧事实。' +
      'date 用事件发生日期(YYYY-MM-DD 或 YYYY-MM), source 注明信息来源(如 "email" / "session" / "feishu")。',
    rules: [CONTACTS_COLLECTION_RULES],
    inputShape: {
      contact_id: z.string().min(1),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}(-\d{2})?$/, 'YYYY-MM-DD 或 YYYY-MM')
        .describe('事件发生日期'),
      text: z.string().min(1).max(1000),
      source: z.string().max(60).optional().describe('信息来源'),
    },
    handler: async (args) =>
      withContacts(deps, (store) =>
        store.appendEvent(args.contact_id as string, {
          date: args.date as string,
          text: args.text as string,
          ...(args.source !== undefined ? { source: args.source as string } : {}),
        }),
        { mutates: true },
      ),
  });
}
