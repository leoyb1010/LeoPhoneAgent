/**
 * vCard 解析 + 批量导入管道单测 — 覆盖 Apple 导出样式解析、归并三分支
 * (identity 自动并入 / 名字相似进 needsReview / 全新创建)、组织任职、分组归属。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import DatabaseCtor from 'better-sqlite3';
import type Database from 'better-sqlite3';

import { MakerContactsStore } from '../store.js';
import { parseVCards, serializeVCards } from '../vcard.js';
import { importContacts } from '../import.js';
import type { Logger } from '../../interfaces/logger.js';

function noopLogger(): Logger {
  const noop = () => {};
  const l: Logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: () => l };
  return l;
}

const APPLE_VCF = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'N:林;子航;;;',
  'FN:林子航',
  'ORG:云岚网络;执行办',
  'TITLE:技术负责人',
  'EMAIL;type=INTERNET;type=WORK;type=pref:neo@example.com',
  'EMAIL;type=INTERNET;type=HOME:neolin@example.net',
  'TEL;type=CELL;type=pref:+86 138 0000 0000',
  'NOTE:蓝川 时期的老搭档\\, 长期合作\\;备注分号',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:3.0',
  'N:Chan;Sonia;;;',
  'FN:Sonia Chan',
  'ORG:云岚网络',
  'EMAIL;type=WORK:sonia@example.com',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:', // 空名 → 解析丢弃
  'END:VCARD',
].join('\r\n');

describe('parseVCards', () => {
  it('解析 Apple 导出样式: 姓名/多邮箱标签/电话/组织/职位/note 转义', () => {
    const recs = parseVCards(APPLE_VCF);
    expect(recs).toHaveLength(2);
    const neo = recs[0]!;
    expect(neo.displayName).toBe('林子航');
    expect(neo.emails).toEqual([
      { value: 'neo@example.com', label: 'work' },
      { value: 'neolin@example.net', label: 'home' },
    ]);
    expect(neo.phones[0]).toEqual({ value: '+86 138 0000 0000', label: 'cell' });
    expect(neo.org).toBe('云岚网络');
    expect(neo.title).toBe('技术负责人');
    expect(neo.note).toBe('蓝川 时期的老搭档, 长期合作;备注分号');
  });

  it('CJK 姓名用 N 拼接(无 FN 时), 拉丁名 名+姓', () => {
    const recs = parseVCards('BEGIN:VCARD\nN:周;子墨;;;\nEND:VCARD\nBEGIN:VCARD\nN:Kim;Remy;;;\nEND:VCARD');
    expect(recs[0]!.displayName).toBe('周子墨');
    expect(recs[1]!.displayName).toBe('Remy Kim');
  });

  it('折行展开与损坏卡片跳过', () => {
    const folded = 'BEGIN:VCARD\r\nFN:折行\r\n 名字\r\nEND:VCARD';
    expect(parseVCards(folded)[0]!.displayName).toBe('折行名字');
    expect(parseVCards('garbage\nBEGIN:VCARD\nEND:VCARD')).toHaveLength(0);
  });
});

describe('importContacts', () => {
  let db: Database.Database;
  let store: MakerContactsStore;

  beforeEach(() => {
    db = new DatabaseCtor(':memory:');
    store = new MakerContactsStore({ db, logger: noopLogger() });
    store.init();
  });

  afterEach(() => db.close());

  it('三分支: identity 并入 / 名字相似 needsReview / 全新创建 + 组织任职 + 分组', () => {
    // 预置: 已有 Neo(带 email)和一个叫 Remy 的人(无身份)
    const existing = store.createContact({
      kind: 'person',
      displayName: 'Neo',
      identities: [{ platform: 'email', value: 'neo@example.com' }],
    });
    store.createContact({ kind: 'person', displayName: 'Remy' });
    const group = store.createGroup('导入批次');

    const summary = importContacts(
      store,
      [
        // → identity 撞 existing, 自动并入
        {
          displayName: '林子航',
          emails: [{ value: 'NEO@EXAMPLE.COM' }],
          phones: [],
          org: '云岚网络',
          title: '技术负责人',
        },
        // → 名字相似(Remy ⊆ Remy Kim)且无身份撞 → needsReview
        { displayName: 'Remy Kim', emails: [], phones: [] },
        // → 全新创建 + 同名组织复用(不重复建)
        {
          displayName: 'Sonia Chan',
          emails: [{ value: 'sonia@example.com', label: 'work' }],
          phones: [],
          org: '云岚网络',
          anchor: { platform: 'apple-contacts', value: 'ABC-123' },
        },
        // → 空名跳过
        { displayName: '  ', emails: [], phones: [] },
      ],
      { groupId: group.id },
    );

    expect(summary.enriched).toBe(1);
    expect(summary.created).toBe(1);
    expect(summary.needsReview).toEqual([{ displayName: 'Remy Kim', candidates: ['Remy'] }]);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.orgsCreated).toBe(1); // 云岚网络只建一次
    expect(summary.relationsAdded).toBe(2);

    // 并入方: 名字成别名, 任职关系挂上
    const neo = store.getContact(existing.id);
    expect(neo.aliases).toContain('林子航');
    expect(neo.relations[0]).toMatchObject({ relation: '任职', note: '技术负责人' });
    // 新建方: 锚点身份 + 分组
    const sonia = store.resolve('sonia@example.com')[0]!.profile;
    expect(sonia.identities.some((i) => i.platform === 'apple-contacts' && i.value === 'ABC-123')).toBe(true);
    expect(sonia.groups.map((g) => g.name)).toEqual(['导入批次']);
    expect(sonia.source).toBe('import');
    // 组织按名字反查可得
    expect(store.resolve('云岚网络')[0]!.profile.kind).toBe('org');
  });

  it('enrich 并入新别名后刷新批内快照: 后续同名无身份记录进 needsReview 不建重复', () => {
    // 回归: enrich 把导入名并成既有档案别名后, 批内快照仍是并入前的名字面,
    // 同批后续该名字(无身份)的记录会漏检直接新建重复档案
    store.createContact({
      kind: 'person',
      displayName: 'Neo',
      identities: [{ platform: 'email', value: 'neo@example.com' }],
    });

    const summary = importContacts(store, [
      // identity 撞 Neo → enrich, "林子航"成为其新别名
      { displayName: '林子航', emails: [{ value: 'neo@example.com' }], phones: [] },
      // 同批后续无身份的同名记录 → 必须名字面撞见刷新后的快照进 needsReview
      { displayName: '林子航', emails: [], phones: [] },
    ]);

    expect(summary.enriched).toBe(1);
    expect(summary.created).toBe(0);
    expect(summary.needsReview).toEqual([{ displayName: '林子航', candidates: ['Neo'] }]);
    expect(store.stats().people).toBe(1);
  });

  it('重复导入同一批幂等: 第二遍全部走 enrich, 不新建', () => {
    const recs = parseVCards(APPLE_VCF);
    const first = importContacts(store, recs);
    expect(first.created).toBe(2);
    const second = importContacts(store, recs);
    expect(second.created).toBe(0);
    expect(second.enriched).toBe(2);
    expect(store.stats().people).toBe(2);
    expect(store.stats().orgs).toBe(1);
  });
});

describe('公司卡片识别(企业/个人不混档)', () => {
  it('X-ABShowAs:COMPANY / 仅 ORG 无人名 → org 档案, 不给自己挂任职', () => {
    const vcf = [
      'BEGIN:VCARD', 'VERSION:3.0', 'N:;;;;', 'FN:顺丰速运', 'ORG:顺丰速运',
      'X-ABShowAs:COMPANY', 'TEL;type=MAIN:95338', 'END:VCARD',
      'BEGIN:VCARD', 'VERSION:3.0', 'N:;;;;', 'FN:', 'ORG:滴滴出行', 'END:VCARD',
    ].join('\r\n');
    const recs = parseVCards(vcf);
    expect(recs[0]).toMatchObject({ displayName: '顺丰速运', kind: 'org' });
    expect(recs[1]).toMatchObject({ displayName: '滴滴出行', kind: 'org' });

    const db = new DatabaseCtor(':memory:');
    const store = new MakerContactsStore({ db, logger: noopLogger() });
    store.init();
    const summary = importContacts(store, recs);
    expect(summary.created).toBe(2);
    expect(summary.relationsAdded).toBe(0); // 公司卡不给自己挂任职
    expect(store.stats()).toMatchObject({ people: 0, orgs: 2 });
    // 跨 kind 查重: 再来一个同名 person 会被拦
    expect(store.findSimilar({ kind: 'person', displayName: '顺丰速运' })[0]!.kind).toBe('org');
    db.close();
  });
});

describe('serializeVCards(导出) round-trip', () => {
  it('导出的 vcf 能被自家解析器读回, 组织/职位/标签/简介保留; 叙事不出库', () => {
    const db = new DatabaseCtor(':memory:');
    const store = new MakerContactsStore({ db, logger: noopLogger() });
    store.init();
    const org = store.createContact({ kind: 'org', displayName: '云岚网络' });
    const p = store.createContact({
      kind: 'person',
      displayName: '林子航',
      summary: '长期老搭档; 含转义,逗号',
      narrative: '绝密叙事不应出现在导出里',
      identities: [
        { platform: 'email', value: 'neo@example.com', label: 'work' },
        { platform: 'phone', value: '+86 138 0000 0000', label: 'cell' },
        { platform: 'github', value: 'neolin' },
      ],
    });
    store.addRelation(p.id, { toId: org.id, relation: '任职', note: '技术负责人' });
    const g = store.createGroup('老搭档');
    store.addToGroup(g.id, [p.id]);

    const vcf = serializeVCards([store.getContact(p.id)]);
    expect(vcf).not.toContain('绝密叙事');
    expect(vcf).toContain('X-XDMAKER-GITHUB:neolin');
    expect(vcf).toContain('CATEGORIES:老搭档');

    const back = parseVCards(vcf);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({
      displayName: '林子航',
      org: '云岚网络',
      title: '技术负责人',
      note: '长期老搭档; 含转义,逗号',
    });
    expect(back[0]!.emails).toEqual([{ value: 'neo@example.com', label: 'work' }]);
    expect(back[0]!.phones).toEqual([{ value: '+86 138 0000 0000', label: 'cell' }]);
    db.close();
  });

  it('分组 round-trip: CATEGORIES 回读(含转义逗号组名), 导入按名 find-or-create 归组', () => {
    // 回归: CATEGORIES 只写不读, 备份/迁移场景联系人恢复但分组全丢
    const db = new DatabaseCtor(':memory:');
    const store = new MakerContactsStore({ db, logger: noopLogger() });
    store.init();
    const p = store.createContact({
      kind: 'person',
      displayName: '林子航',
      identities: [{ platform: 'email', value: 'neo@example.com' }],
    });
    const g1 = store.createGroup('老搭档');
    const g2 = store.createGroup('云岚,创始团队'); // 组名含逗号 → 导出转义 \,
    store.addToGroup(g1.id, [p.id]);
    store.addToGroup(g2.id, [p.id]);

    const vcf = serializeVCards([store.getContact(p.id)]);
    const back = parseVCards(vcf);
    expect([...(back[0]!.groups ?? [])].sort()).toEqual(['云岚,创始团队', '老搭档']);

    // 导入到干净库: 分组按名重建 + 归组
    const db2 = new DatabaseCtor(':memory:');
    const store2 = new MakerContactsStore({ db: db2, logger: noopLogger() });
    store2.init();
    const summary = importContacts(store2, back);
    expect(summary.created).toBe(1);
    const restored = store2.resolve('neo@example.com')[0]!.profile;
    expect(restored.groups.map((g) => g.name).sort()).toEqual(['云岚,创始团队', '老搭档']);
    // 二次导入幂等: 分组复用不重复建
    importContacts(store2, back);
    expect(store2.listGroups()).toHaveLength(2);
    db.close();
    db2.close();
  });
});
