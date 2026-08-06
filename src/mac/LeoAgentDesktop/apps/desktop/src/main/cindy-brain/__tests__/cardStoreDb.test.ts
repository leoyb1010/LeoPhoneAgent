/**
 * cardStoreDb.test.ts — ghost_cards 持久层单测。
 * 内存 SQLite + 真实 0072 migration SQL 建表(与生产 schema 同源),直测
 * 注入 db 的纯函数(规则 14)。覆盖:upsert 幂等(过程版被终版覆盖)、
 * 取件 null 语义、GC 上限按最旧淘汰。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { GhostCardDb } from '../cardStoreDb';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/never-used-here' },
}));

const schema = await import('../../localDb/schema');
const store = await import('../cardStoreDb');

const MIGRATION_0072 = path.resolve(__dirname, '../../../../drizzle/0072_first_lightspeed.sql');

function freshDb(): GhostCardDb {
  const raw = new Database(':memory:');
  const sqlText = fs.readFileSync(MIGRATION_0072, 'utf8');
  for (const stmt of sqlText.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim();
    if (trimmed) raw.exec(trimmed);
  }
  return drizzle(raw, { schema }) as unknown as GhostCardDb;
}

function row(callId: string, over: Partial<Parameters<typeof store.upsertGhostCard>[0]> = {}) {
  return {
    callId,
    ghostId: 'g1',
    sessionId: null,
    html: '<p>x</p>',
    height: 240,
    v: 1,
    updatedAt: 1000,
    ...over,
  };
}

let db: GhostCardDb;

beforeEach(() => {
  db = freshDb();
});

describe('cardStoreDb', () => {
  it('upsert 幂等:同 callId 二次写入覆盖为最新版本', async () => {
    await store.upsertGhostCard(row('c1', { html: '<p>过程</p>' }), db);
    await store.upsertGhostCard(row('c1', { html: '<p>终版</p>', height: 400, updatedAt: 2000 }), db);
    const got = await store.getGhostCard('c1', db);
    expect(got).toEqual({ callId: 'c1', ghostId: 'g1', sessionId: null, html: '<p>终版</p>', height: 400, v: 1 });
  });

  it('取件:无卡返回 null', async () => {
    expect(await store.getGhostCard('nope', db)).toBeNull();
  });

  it('GC:超上限按 updatedAt 淘汰最旧', async () => {
    const total = store.GHOST_CARDS_MAX_ROWS + 3;
    // 直插底表绕过抽样计数,末尾显式触发裁剪。
    for (let i = 0; i < total; i++) {
      await store.upsertGhostCard(row(`c${i}`, { updatedAt: i }), db);
    }
    const pruned = await store.pruneGhostCards(db);
    expect(pruned).toBeGreaterThanOrEqual(0);
    // 无论抽样是否已触发过,最终不超上限,且最旧的必然出局、最新的仍在。
    expect(await store.getGhostCard('c0', db)).toBeNull();
    expect(await store.getGhostCard(`c${total - 1}`, db)).not.toBeNull();
  });
  it('权威实测高写回:已有行更新,行不存在静默不造卡', async () => {
    await store.upsertGhostCard(row('c1', { height: 500 }), db);
    await store.updateGhostCardHeight('c1', 613, db);
    expect((await store.getGhostCard('c1', db))?.height).toBe(613);
    await store.updateGhostCardHeight('ghost-town', 300, db);
    expect(await store.getGhostCard('ghost-town', db)).toBeNull();
  });
});
