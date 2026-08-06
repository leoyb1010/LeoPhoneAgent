/**
 * ContactsGroupsRepo — 分组子仓(分组 CRUD + 成员管理)。
 * store 组合持有并直通暴露; 拆出来是为了让 store 聚焦实体/身份/事件主链路。
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import {
  ContactsError,
  type ContactGroup,
  type ContactGroupWithCount,
  type ContactsConfig,
} from './types.js';

export class ContactsGroupsRepo {
  constructor(
    private readonly db: Database.Database,
    private readonly config: ContactsConfig,
  ) {}

  createGroup(name: string, description = ''): ContactGroup {
    const trimmed = this.validateName(name);
    const exists = this.db.prepare(`SELECT id FROM contact_groups WHERE name = ?`).get(trimmed);
    if (exists) throw new ContactsError('already-exists', `group already exists: ${trimmed}`);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO contact_groups(id, name, description, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, trimmed, description.trim(), now);
    return { id, name: trimmed, description: description.trim(), createdAt: now };
  }

  updateGroup(id: string, patch: { name?: string; description?: string }): ContactGroup {
    const row = this.db.prepare(`SELECT * FROM contact_groups WHERE id = ?`).get(id) as
      | { id: string; name: string; description: string; created_at: string }
      | undefined;
    if (!row) throw new ContactsError('not-found', `group not found: ${id}`);
    const name = patch.name !== undefined ? this.validateName(patch.name) : row.name;
    if (name !== row.name) {
      const dup = this.db.prepare(`SELECT id FROM contact_groups WHERE name = ? AND id != ?`).get(name, id);
      if (dup) throw new ContactsError('already-exists', `group already exists: ${name}`);
    }
    const description = patch.description?.trim() ?? row.description;
    this.db.prepare(`UPDATE contact_groups SET name = ?, description = ? WHERE id = ?`).run(name, description, id);
    return { id, name, description, createdAt: row.created_at };
  }

  deleteGroup(id: string): void {
    const res = this.db.prepare(`DELETE FROM contact_groups WHERE id = ?`).run(id);
    if (res.changes === 0) throw new ContactsError('not-found', `group not found: ${id}`);
  }

  listGroups(): ContactGroupWithCount[] {
    const rows = this.db
      .prepare(
        `SELECT g.*, (SELECT COUNT(*) FROM contact_group_members m WHERE m.group_id = g.id) AS member_count
         FROM contact_groups g ORDER BY g.name`,
      )
      .all() as Array<{ id: string; name: string; description: string; created_at: string; member_count: number }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      createdAt: r.created_at,
      memberCount: r.member_count,
    }));
  }

  addToGroup(groupId: string, contactIds: string[]): void {
    const group = this.db.prepare(`SELECT id FROM contact_groups WHERE id = ?`).get(groupId);
    if (!group) throw new ContactsError('not-found', `group not found: ${groupId}`);
    const contactExists = this.db.prepare(`SELECT id FROM contacts WHERE id = ?`);
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO contact_group_members(group_id, contact_id) VALUES (?, ?)`,
    );
    const tx = this.db.transaction((ids: string[]) => {
      for (const cid of ids) {
        if (!contactExists.get(cid)) throw new ContactsError('not-found', `contact not found: ${cid}`);
        insert.run(groupId, cid);
      }
    });
    tx(contactIds);
  }

  removeFromGroup(groupId: string, contactIds: string[]): void {
    // 与 addToGroup 同一套存在性契约: 组/联系人不存在按 not-found 报错, 否则
    // 打错组名/组已被并发删除时调用方拿到 {removed:n} 的假成功。
    // "联系人存在但不在组内"仍幂等跳过 — 与 add 的"已在组内幂等"对称。
    const group = this.db.prepare(`SELECT id FROM contact_groups WHERE id = ?`).get(groupId);
    if (!group) throw new ContactsError('not-found', `group not found: ${groupId}`);
    const contactExists = this.db.prepare(`SELECT id FROM contacts WHERE id = ?`);
    const stmt = this.db.prepare(`DELETE FROM contact_group_members WHERE group_id = ? AND contact_id = ?`);
    const tx = this.db.transaction((ids: string[]) => {
      for (const cid of ids) {
        if (!contactExists.get(cid)) throw new ContactsError('not-found', `contact not found: ${cid}`);
        stmt.run(groupId, cid);
      }
    });
    tx(contactIds);
  }

  private validateName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > this.config.maxGroupNameLen) {
      throw new ContactsError('invalid-params', `group name must be 1..${this.config.maxGroupNameLen} chars`);
    }
    return trimmed;
  }
}
