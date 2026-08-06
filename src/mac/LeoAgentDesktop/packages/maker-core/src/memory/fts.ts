/**
 * MemoryFts — 给 MakerMemory 分片挂 SQLite FTS5 全文检索 (Hermes 风格)。
 *
 * 设计取舍:
 *  - 用 standalone FTS5 (所有列存表内, 含 body) 而非 contentless / external content。
 *    理由: memory 量级小 (per-workdir 几十到一两百条), 空间开销可忽略;
 *    standalone 直接支持 snippet() 高亮, 不用维护内容→FTS 同步关系。
 *  - tokenize='porter unicode61' — porter stemming + unicode61 分词, 中文按字符拆 (够用,
 *    专业中文 tokenizer 等真实漏检率高了再上 jieba)。
 *  - upsert = DELETE + INSERT (FTS5 没有 ON CONFLICT 子句)。
 *  - 不在 maker-core 加 better-sqlite3 runtime dep — 用 type-only import, 实例由 host
 *    (desktop) 注入, 跟 zero-electron-deps 边界一致。
 *
 * 失败原则:
 *  FTS5 同步失败不阻塞主流程 (调用方 storage.write 已经成功落盘) — 调用方 catch 后只 log,
 *  下次 rebuild 时检测到不一致重建。文件是 source of truth, FTS5 是派生索引。
 */

import type Database from 'better-sqlite3';

import {
  MemoryError,
  type MemoryRecord,
  type MemoryType,
  type SearchHit,
  type SearchOptions,
} from './types.js';

const TABLE = 'memory_fts';
const SNIPPET_TOKEN_RADIUS = 8; // snippet() 命中前后各取 N tokens
const DEFAULT_LIMIT = 10;

export class MemoryFts {
  constructor(private readonly db: Database.Database) {}

  /** 创建 memory_fts 虚拟表 (idempotent). manager 启动时调一次。 */
  init(): void {
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE} USING fts5(
         filename UNINDEXED,
         type UNINDEXED,
         title,
         description,
         body,
         tokenize='porter unicode61'
       );`,
    );
  }

  /** 写入或更新一条记录 (按 filename 去重) */
  upsert(record: MemoryRecord): void {
    const tx = this.db.transaction((rec: MemoryRecord) => {
      this.db.prepare(`DELETE FROM ${TABLE} WHERE filename = ?`).run(rec.filename);
      this.db.prepare(
        `INSERT INTO ${TABLE}(filename, type, title, description, body) VALUES (?, ?, ?, ?, ?)`,
      ).run(rec.filename, rec.frontmatter.type, rec.frontmatter.title, rec.frontmatter.description, rec.body);
    });
    try {
      tx(record);
    } catch (e) {
      throw new MemoryError('io-error', `fts upsert failed: ${(e as Error).message}`);
    }
  }

  /** 按 filename 删除. 不存在 no-op (跟 fs delete 失败语义解耦) */
  delete(filename: string): void {
    try {
      this.db.prepare(`DELETE FROM ${TABLE} WHERE filename = ?`).run(filename);
    } catch (e) {
      throw new MemoryError('io-error', `fts delete failed: ${(e as Error).message}`);
    }
  }

  /**
   * 全文检索. query 直接走 FTS5 MATCH 语法 (支持 AND/OR/NOT/phrase "...")。
   * 返回按 bm25 排序 (越小越相关) 的命中, 含 snippet() 高亮片段。
   */
  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    if (!query || query.trim().length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, 50));
    const escapedQuery = escapeFtsQuery(query);

    let sql = `SELECT filename, type, title,
                      snippet(${TABLE}, -1, '<mark>', '</mark>', '…', ${SNIPPET_TOKEN_RADIUS}) AS snippet,
                      bm25(${TABLE}) AS score
               FROM ${TABLE}
               WHERE ${TABLE} MATCH ?`;
    const params: unknown[] = [escapedQuery];
    if (opts.type) {
      sql += ` AND type = ?`;
      params.push(opts.type);
    }
    sql += ` ORDER BY score LIMIT ?`;
    params.push(limit);

    try {
      const rows = this.db.prepare(sql).all(...params) as Array<{
        filename: string;
        type: string;
        title: string;
        snippet: string;
        score: number;
      }>;
      return rows.map((r) => ({
        filename: r.filename,
        type: r.type as MemoryType,
        title: r.title,
        snippet: r.snippet,
        score: r.score,
      }));
    } catch (e) {
      // FTS5 query 语法错 (用户传了非法 token) 直接返空, 不抛 — 让 LLM 改写 query 重试。
      const msg = (e as Error).message;
      if (msg.includes('fts5') || msg.includes('syntax error')) return [];
      throw new MemoryError('io-error', `fts search failed: ${msg}`);
    }
  }

  /**
   * 全量重建. 在事务内 DELETE + 重新 INSERT 所有 records。
   * 调用时机: storage 跟 fts 检测到不一致 (count 对不上) / 启动 sanity check / 手动触发。
   */
  rebuild(records: readonly MemoryRecord[]): void {
    const tx = this.db.transaction((recs: readonly MemoryRecord[]) => {
      this.db.exec(`DELETE FROM ${TABLE}`);
      const stmt = this.db.prepare(
        `INSERT INTO ${TABLE}(filename, type, title, description, body) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const r of recs) {
        stmt.run(r.filename, r.frontmatter.type, r.frontmatter.title, r.frontmatter.description, r.body);
      }
    });
    try {
      tx(records);
    } catch (e) {
      throw new MemoryError('io-error', `fts rebuild failed: ${(e as Error).message}`);
    }
  }

  /** 当前 FTS 表里的行数 — 用于 sanity check (跟 storage.list().length 对比) */
  count(): number {
    try {
      const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${TABLE}`).get() as { c: number };
      return row.c;
    } catch {
      return -1; // 表不存在 / 损坏
    }
  }
}

/**
 * FTS5 query 转义 — 用户输入的特殊字符 (双引号/括号/列名前缀) 会被解析成语法 token,
 * 保险起见把整个 query 包成 phrase ("...") 走精确匹配, 同时把内部双引号 escape。
 *
 * 这样的副作用: AND/OR/NOT 这些 LLM 想用的 advanced query 也被吞了 — 短期可接受,
 * 后续如果 LLM 表达需求强, 可以加 "raw mode" 选项绕过。
 */
function escapeFtsQuery(q: string): string {
  return `"${q.trim().replace(/"/g, '""')}"`;
}
