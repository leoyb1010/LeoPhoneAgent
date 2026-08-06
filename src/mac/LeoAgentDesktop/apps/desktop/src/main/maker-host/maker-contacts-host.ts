/**
 * apps/desktop/src/main/maker-host/maker-contacts-host.ts
 *
 * Desktop 端 MakerContactsManager(智能通讯录)工厂 + 模块级懒加载单例。
 * 负责注入 host-only 依赖(与 maker-memory-host 同模式):
 *  - sqliteFactory: better-sqlite3 实例化(native module, 不能放 maker-core)
 *  - basePath: app.getPath('userData'); manager 内部自己拼 'maker-contacts/contacts.db'
 *
 * 与 memory 的差异: 通讯录不进 Maker deps(与 agent 生命周期无耦合, enable 无需
 * 联动 agents), 所以不吃 Maker.shutdown 的 dispose — 这里自己挂 app will-quit
 * 关库。单例懒加载: 第一次消费(MCP 工具调用 / 设置 UI IPC)才 open db。
 */

import { app } from 'electron';

import { MakerContactsManager, type ContactsSqliteFactory } from '@cindy/maker-core';

import { desktopMakerLogger } from './logger-adapter.js';
import { createBetterSqliteDatabase } from '../localDb/betterSqliteFactory.js';
import {
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';

const sqliteFactory: ContactsSqliteFactory = (filePath) => {
  // WAL + busy_timeout 与 memory fts.db 同配置; schema 内 initContactsSchema 会再
  // 设 journal_mode/foreign_keys(pragma 幂等)。
  const db = createBetterSqliteDatabase(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
};

let singleton: MakerContactsManager | null = null;

/** 拿 desktop 全局 MakerContactsManager 单例(懒创建, 首次调用挂 will-quit 清理)。 */
export function getDesktopContactsManager(): MakerContactsManager {
  if (isAppSessionBoundaryPending()) {
    throw new Error('contacts unavailable while app session is switching');
  }
  if (singleton) return singleton;
  singleton = new MakerContactsManager({
    basePath: ownerScopedUserDataPath(),
    sqliteFactory,
    logger: desktopMakerLogger.child('maker-contacts'),
  });
  app.on('will-quit', () => {
    disposeDesktopContactsManager();
  });
  return singleton;
}

/** 关库 + 清单例. 幂等; 主要给 will-quit 和测试用。 */
export function disposeDesktopContactsManager(): void {
  if (!singleton) return;
  singleton.dispose();
  singleton = null;
}
