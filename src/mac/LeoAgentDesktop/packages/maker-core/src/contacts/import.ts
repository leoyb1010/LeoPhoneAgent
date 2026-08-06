/**
 * contacts/import.ts — 批量导入管道(系统通讯录 / vCard 共用)。
 *
 * 每条记录走确定性归并(规则 9, 复用 findSimilar/enrich 这套代码防线):
 *  - 身份(邮箱/电话/锚点)与既有档案精确撞 → 自动并入(enrich), 绝不建重复
 *  - 名字相似但无身份撞 → 不创建, 进 needsReview 报告(由用户/agent 逐个裁决)
 *  - 全新 → 创建(source 默认 'import')
 *  - 带 org 的: 组织档案 find-or-create + 「任职」关系边(title 进 note)
 *  - 指定 groupId 时, 新建/并入的条目都归组
 *
 * 单条失败不打断整批(skipped 记录原因); 组织缓存避免同名 org 重复解析。
 * 性能: 名字面快照批内共享+增量追加(新建行立刻可被后续记录撞见),
 * 避免每条记录全表扫描 + JSON.parse。
 */

import { buildSnapshotEntry } from './dedupe.js';
import type { MakerContactsStore } from './store.js';
import {
  ContactsError,
} from './types.js';
import type {
  CreateContactInput,
  ImportContactRecord,
  ImportContactsOptions,
  ImportSummary,
} from './types.js';

const MAX_IMPORT_BATCH = 2000;

export function importContacts(
  store: MakerContactsStore,
  records: ImportContactRecord[],
  opts: ImportContactsOptions = {},
): ImportSummary {
  const summary: ImportSummary = {
    created: 0,
    enriched: 0,
    needsReview: [],
    skipped: [],
    orgsCreated: 0,
    relationsAdded: 0,
    identityConflicts: [],
    relationErrors: [],
  };
  const source = opts.source ?? 'import';
  // groupId 入口 fail-fast: 组不存在时 addToGroup 会在逐条循环里反复抛 FK 异常,
  // 且 created/enriched 已先递增, 同一条记录会同时计入 created 和 skipped(统计失真)
  if (opts.groupId && !store.listGroups().some((g) => g.id === opts.groupId)) {
    throw new ContactsError('not-found', `group not found: ${opts.groupId}`);
  }
  const orgCache = new Map<string, string>(); // 组织名(小写) → contactId
  const groupCache = new Map<string, string>(); // 分组名 → groupId(批内 find-or-create 缓存)
  const snapshot = store.createNameSnapshot(); // 批内共享名字面快照, 新建行增量追加
  const batch = records.slice(0, MAX_IMPORT_BATCH);
  if (records.length > batch.length) {
    summary.skipped.push({
      displayName: `…${records.length - batch.length} more`,
      reason: `batch limit ${MAX_IMPORT_BATCH}`,
    });
  }

  for (const rec of batch) {
    const displayName = rec.displayName?.trim();
    if (!displayName) {
      summary.skipped.push({ displayName: '(empty)', reason: 'empty name' });
      continue;
    }
    try {
      const identities: NonNullable<CreateContactInput['identities']> = [
        ...rec.emails.map((e) => ({
          platform: 'email',
          value: e.value,
          ...(e.label ? { label: e.label } : {}),
        })),
        ...rec.phones.map((p) => ({
          platform: 'phone',
          value: p.value,
          ...(p.label ? { label: p.label } : {}),
        })),
        // vCard X-XDMAKER-* 扩展回读的平台身份(feishu/github/...), export→import 不丢
        ...(rec.identities ?? []).map((i) => ({
          platform: i.platform,
          value: i.value,
          ...(i.label ? { label: i.label } : {}),
        })),
        ...(rec.anchor ? [{ platform: rec.anchor.platform, value: rec.anchor.value, label: '锚点' }] : []),
      ];
      const kind = rec.kind ?? 'person';
      const input: CreateContactInput = {
        kind,
        displayName,
        ...(rec.note ? { narrative: `<!-- imported note -->\n${rec.note}` } : {}),
        identities,
        source,
      };

      const candidates = store.findSimilar(input, snapshot);
      const identityHit = candidates.find((c) => c.matchType === 'identity');
      let contactId: string;
      if (identityHit) {
        const enrichResult = store.enrichContact(identityHit.contactId, input);
        contactId = identityHit.contactId;
        summary.enriched += 1;
        // conflict-other = 记录里另一个身份已属于第三方档案 — 两份档案疑似同人,
        // 收进摘要驱动后续 merge 裁决, 不能随 enrich 返回值静默蒸发
        for (const skipped of enrichResult.skippedIdentities) {
          if (skipped.reason === 'conflict-other' && skipped.conflictContactId) {
            summary.identityConflicts.push({
              displayName,
              platform: skipped.platform,
              value: skipped.value,
              conflictContactId: skipped.conflictContactId,
            });
          }
        }
        // enrich 会把导入名并成既有档案的新别名 — 刷新该档案的快照条目, 批内
        // 后续同名(无身份)记录才能名字面撞见它进 needsReview, 否则漏检建重复档案
        const merged = store.getContact(contactId);
        const refreshed = buildSnapshotEntry({
          id: merged.id,
          kind: merged.kind,
          displayName: merged.displayName,
          aliases: merged.aliases,
          status: merged.status,
          summary: merged.summary,
        });
        const idx = snapshot.findIndex((s) => s.id === contactId);
        if (idx >= 0) snapshot[idx] = refreshed;
        else snapshot.push(refreshed);
      } else {
        const nameHits = candidates.filter((c) => c.matchType === 'name');
        if (nameHits.length > 0) {
          summary.needsReview.push({
            displayName,
            candidates: nameHits.map((c) => c.displayName),
          });
          continue;
        }
        const created = store.createContact(input);
        contactId = created.id;
        summary.created += 1;
        // 追进快照, 批内后续同名记录能撞见它(否则整批重复名各建一份)
        snapshot.push(
          buildSnapshotEntry({
            id: created.id,
            kind: created.kind,
            displayName: created.displayName,
            aliases: created.aliases,
            status: created.status,
            summary: created.summary,
          }),
        );
      }

      // 组织 find-or-create + 任职关系(已存在同名关系时静默跳过)。
      // 公司卡片自身不挂任职(ORG 字段就是它自己的名字)
      const orgName = kind === 'org' ? undefined : rec.org?.trim();
      // 整个 org find-or-create + 建边块自成故障域: 此时人已建档/并入并计数,
      // org 侧任何失败(如公司名超显示名上限建档被拒)都只该记 relationErrors,
      // 不能抛到外层 per-record catch — 那会把已入库的记录再计入 skipped
      // (created+skipped 双计), 且雇主关系丢失无声
      if (orgName) {
        try {
          const key = orgName.toLowerCase();
          let orgId = orgCache.get(key);
          if (!orgId) {
            // 组织归并必须精确(显示名/别名等值命中), 不能用模糊 namesSimilar —
            // "云岚" 撞 "云岚网络" 会把成员静默挂错公司; 也不能用 identity 优先的
            // resolve — 某人的 handle 恰好同值公司名时 tier-1 短路, 名字层的真
            // org 命中永远到不了(重复建 org / 挂错对象)
            const orgHits = store.findByExactName(orgName, { kind: 'org' });
            if (orgHits.length > 0) {
              orgId = orgHits[0]!.id;
            } else {
              const createdOrg = store.createContact({ kind: 'org', displayName: orgName, source });
              orgId = createdOrg.id;
              summary.orgsCreated += 1;
              snapshot.push(
                buildSnapshotEntry({
                  id: createdOrg.id,
                  kind: 'org',
                  displayName: createdOrg.displayName,
                  status: createdOrg.status,
                }),
              );
            }
            orgCache.set(key, orgId);
          }
          try {
            store.addRelation(contactId, {
              toId: orgId,
              relation: '任职',
              ...(rec.title ? { note: rec.title } : {}),
            });
            summary.relationsAdded += 1;
          } catch (e) {
            if (!(e instanceof ContactsError && e.code === 'already-exists')) throw e;
            // 同 (from,to,relation) 已存在 → 幂等跳过
          }
        } catch (e) {
          // 失败不吞: 档案本体已导入, 但 employer/title 关系丢了 — 浮进摘要
          summary.relationErrors.push({
            displayName,
            org: orgName,
            reason: (e as Error).message.slice(0, 120),
          });
        }
      }

      if (opts.groupId) {
        store.addToGroup(opts.groupId, [contactId]);
      }

      // vCard CATEGORIES 回读的分组: 按名 find-or-create 后归组(与批级 groupId 叠加)。
      // 单个分组失败(如名字超长)不拖垮整条记录 — 联系人本体已成功导入
      for (const rawName of rec.groups ?? []) {
        const name = rawName.trim();
        if (!name) continue;
        try {
          let gid = groupCache.get(name);
          if (!gid) {
            const existing = store.listGroups().find((g) => g.name === name);
            gid = existing ? existing.id : store.createGroup(name).id;
            groupCache.set(name, gid);
          }
          store.addToGroup(gid, [contactId]);
        } catch {
          // 分组名非法/超长等 → 跳过该分组, 不影响档案本体
        }
      }
    } catch (e) {
      summary.skipped.push({ displayName, reason: (e as Error).message.slice(0, 120) });
    }
  }
  return summary;
}
