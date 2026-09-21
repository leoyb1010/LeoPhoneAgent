import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

import { leoPath } from "./leoPaths.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type Db = InstanceType<typeof DatabaseSync>;

export type TreasuryKind = "link" | "text" | "note" | "artifact";
export type ReadingState = "none" | "unread" | "reading" | "read";

export interface TreasuryItem {
  id: string;
  kind: TreasuryKind;
  title: string;
  content: string;
  source_uri: string | null;
  tags: string[];
  annotation: string | null;
  reading_state: ReadingState;
  archived: boolean;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

interface Row {
  id: string;
  kind: string;
  title: string;
  content: string;
  source_uri: string | null;
  tags: string;
  annotation: string | null;
  reading_state: string;
  archived: number;
  pinned: number;
  created_at: string;
  updated_at: string;
}

function toItem(row: Row): TreasuryItem {
  return {
    id: row.id,
    kind: row.kind as TreasuryKind,
    title: row.title,
    content: row.content,
    source_uri: row.source_uri,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
    annotation: row.annotation,
    reading_state: row.reading_state as ReadingState,
    archived: row.archived === 1,
    pinned: row.pinned === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * [leo] 藏宝阁本机存储。用 node:sqlite(运行时自带,不引第三方原生模块,
 * 免得每次 Electron 升级都要重编)。库放在 `~/.leoagent/`,和 ZCode 的库分开,
 * 上游同步不会碰它。
 */
export class TreasuryStore {
  private db: Db | null = null;

  private handle(): Db {
    if (this.db) return this.db;
    const file = leoPath("treasury.sqlite");
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      source_uri TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      annotation TEXT,
      reading_state TEXT NOT NULL DEFAULT 'none',
      archived INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS items_updated ON items(updated_at DESC)");
    this.db = db;
    return db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  save(input: {
    kind: TreasuryKind;
    content: string;
    title?: string;
    tags?: string[];
    source_uri?: string | null;
  }): TreasuryItem {
    const now = new Date().toISOString();
    const id = randomUUID();
    const title = (input.title ?? "").trim() || input.content.trim().split("\n")[0]?.slice(0, 80) || "未命名";
    this.handle()
      .prepare(
        `INSERT INTO items (id, kind, title, content, source_uri, tags, annotation, reading_state, archived, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'none', 0, 0, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        title,
        input.content,
        input.source_uri ?? null,
        JSON.stringify(input.tags ?? []),
        now,
        now,
      );
    return this.get([id])[0]!;
  }

  get(ids: string[]): TreasuryItem[] {
    if (ids.length === 0) return [];
    const marks = ids.map(() => "?").join(",");
    const rows = this.handle()
      .prepare(`SELECT * FROM items WHERE id IN (${marks})`)
      .all(...ids) as unknown as Row[];
    return rows.map(toItem);
  }

  /** 朴素相关度:标题命中比正文重,pinned 置顶,再按更新时间。够用,不引全文索引。 */
  search(params: {
    query: string;
    limit: number;
    kinds?: string[];
    tags?: string[];
    readingState?: ReadingState | null;
    includeArchived?: boolean;
  }): Array<TreasuryItem & { score: number }> {
    const rows = this.handle()
      .prepare(
        `SELECT * FROM items ${params.includeArchived ? "" : "WHERE archived = 0"} ORDER BY updated_at DESC LIMIT 2000`,
      )
      .all() as unknown as Row[];
    const needle = params.query.trim().toLocaleLowerCase();
    const kinds = new Set((params.kinds ?? []).map((value) => value.toLocaleLowerCase()));
    const tags = new Set((params.tags ?? []).map((value) => value.toLocaleLowerCase()));
    const scored: Array<TreasuryItem & { score: number }> = [];
    for (const row of rows) {
      const item = toItem(row);
      if (kinds.size > 0 && !kinds.has(item.kind)) continue;
      if (tags.size > 0 && !item.tags.some((tag) => tags.has(tag.toLocaleLowerCase()))) continue;
      if (params.readingState && item.reading_state !== params.readingState) continue;
      let score = 0;
      if (needle) {
        const title = item.title.toLocaleLowerCase();
        const content = item.content.toLocaleLowerCase();
        if (title.includes(needle)) score += 10;
        if (content.includes(needle)) score += 3;
        if (item.tags.some((tag) => tag.toLocaleLowerCase().includes(needle))) score += 4;
        if (score === 0) continue;
      } else {
        score = 1;
      }
      if (item.pinned) score += 5;
      scored.push({ ...item, score });
    }
    scored.sort((left, right) => right.score - left.score || right.updated_at.localeCompare(left.updated_at));
    return scored.slice(0, params.limit);
  }

  update(
    id: string,
    patch: Partial<Pick<TreasuryItem, "title" | "tags" | "annotation" | "reading_state" | "archived" | "pinned">>,
  ): TreasuryItem | null {
    const current = this.get([id])[0];
    if (!current) return null;
    const next = { ...current, ...patch, updated_at: new Date().toISOString() };
    this.handle()
      .prepare(
        `UPDATE items SET title = ?, tags = ?, annotation = ?, reading_state = ?, archived = ?, pinned = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.title,
        JSON.stringify(next.tags),
        next.annotation,
        next.reading_state,
        next.archived ? 1 : 0,
        next.pinned ? 1 : 0,
        next.updated_at,
        id,
      );
    return this.get([id])[0] ?? null;
  }

  count(): number {
    const row = this.handle().prepare("SELECT COUNT(*) AS n FROM items").get() as unknown as { n: number };
    return row?.n ?? 0;
  }
}
