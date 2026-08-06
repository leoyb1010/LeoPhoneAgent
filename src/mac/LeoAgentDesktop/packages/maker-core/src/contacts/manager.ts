/**
 * MakerContactsManager — 智能通讯录顶层单例, 持有全局唯一 store。
 *
 * 与 MakerMemoryManager 的差异:
 *  - Memory 是 per-workdir 实例池; Contacts 是全局单库单 store(人不属于项目),
 *    db 固定在 <basePath>/maker-contacts/contacts.db。
 *  - enabled 开关不放在 manager 内 — 通讯录的功能开关是 host 设置层的职责
 *    (settings store + plugin gate), manager 只管"要用的时候能拿到 store"。
 *
 * 生命周期: host 装配阶段创建, Maker.shutdown 时 dispose(关 db)。幂等。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';

import { MakerContactsStore } from './store.js';
import type { ContactsConfig } from './types.js';
import type { Logger } from '../interfaces/logger.js';

/** 工厂函数: 给绝对文件路径返回 better-sqlite3 实例。host 注入(native module 不进 maker-core 依赖) */
export type ContactsSqliteFactory = (filePath: string) => Database.Database;

export interface MakerContactsManagerDeps {
  /** 数据根目录, host 注入 (e.g. <electron userData>) — 库文件落在 <basePath>/maker-contacts/ */
  basePath: string;
  sqliteFactory: ContactsSqliteFactory;
  logger: Logger;
  config?: Partial<ContactsConfig>;
}

const CONTACTS_SUBDIR = 'maker-contacts';
const CONTACTS_DB_FILENAME = 'contacts.db';

export class MakerContactsManager {
  private entry: { store: MakerContactsStore; db: Database.Database } | null = null;
  private readonly logger: Logger;

  constructor(private readonly deps: MakerContactsManagerDeps) {
    this.logger = deps.logger;
    this.logger.info('MakerContactsManager initialized', { basePath: deps.basePath });
  }

  /** 库文件绝对路径(调试/导出用) */
  getDbPath(): string {
    return path.join(this.deps.basePath, CONTACTS_SUBDIR, CONTACTS_DB_FILENAME);
  }

  /** lazy open: mkdir + open db + schema 迁移 + sanity check。同实例复用。失败抛错 */
  getStore(): MakerContactsStore {
    if (this.entry) return this.entry.store;
    const dbPath = this.getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = this.deps.sqliteFactory(dbPath);
    let store: MakerContactsStore;
    try {
      store = new MakerContactsStore({
        db,
        logger: this.logger.child('contacts'),
        ...(this.deps.config ? { config: this.deps.config } : {}),
      });
      store.init();
    } catch (e) {
      // init 失败必须关掉已 open 的 db 句柄, 否则每次重试都泄漏一个文件句柄
      try {
        db.close();
      } catch {
        /* close 失败无可恢复动作 */
      }
      throw e;
    }
    this.entry = { store, db };
    this.logger.debug('contacts store opened', { dbPath });
    return store;
  }

  /** 是否已 open(热路径快查, 不触发 lazy open) */
  hasStore(): boolean {
    return this.entry !== null;
  }

  /** 清空整个通讯录(设置 UI 二次确认后调) */
  resetAll(): { removedCount: number } {
    return this.getStore().resetAll();
  }

  /** Maker.shutdown 调. 关 db, 清引用. 幂等 */
  dispose(): void {
    if (!this.entry) return;
    try {
      this.entry.db.close();
    } catch (e) {
      this.logger.warn('dispose: contacts db close failed', { error: String(e) });
    }
    this.entry = null;
    this.logger.info('MakerContactsManager disposed');
  }
}
