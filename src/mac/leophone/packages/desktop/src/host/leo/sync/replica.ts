import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import {
  canonical,
  check,
  MAX_ASSET,
  MAX_BATCH_BYTES,
  MAX_CHUNK,
  validateChanges,
} from "./wire.js";
import type { Receipt, SyncChange } from "./wire.js";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type Db = InstanceType<typeof DatabaseSync>;
interface Latest {
  sender: string;
  revision: number;
  changed: number;
  operation: string;
  tie: string;
  cursor: number;
}
interface AssetStatus {
  size: number;
  offset: number;
  complete: boolean;
}

export class SyncReplicaStore {
  readonly replicaId: string;
  private constructor(private db: Db) {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes(cursor INTEGER PRIMARY KEY AUTOINCREMENT,sender TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS latest(type TEXT NOT NULL,id TEXT NOT NULL,sender TEXT NOT NULL,revision INTEGER NOT NULL,changed REAL NOT NULL,operation TEXT NOT NULL,tie TEXT NOT NULL,cursor INTEGER NOT NULL,PRIMARY KEY(type,id));
      CREATE TABLE IF NOT EXISTS receipts(sender TEXT NOT NULL,change_id TEXT NOT NULL,digest TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(sender,change_id));
      CREATE TABLE IF NOT EXISTS revisions(sender TEXT NOT NULL,type TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(sender,type,id));
      CREATE TABLE IF NOT EXISTS assets(hash TEXT PRIMARY KEY,size INTEGER NOT NULL,offset INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS chunks(hash TEXT NOT NULL,offset INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(hash,offset),FOREIGN KEY(hash) REFERENCES assets(hash) ON DELETE CASCADE);`);
    db.prepare("INSERT OR IGNORE INTO metadata VALUES ('replicaId', ?)").run(randomUUID());
    this.replicaId = String(
      db.prepare("SELECT value FROM metadata WHERE key='replicaId'").get()!.value,
    );
  }
  static async open(directory: string): Promise<SyncReplicaStore> {
    check(isAbsolute(directory), "replica directory must be absolute");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new SyncReplicaStore(new DatabaseSync(join(directory, "replica.sqlite")));
  }
  close() {
    this.db.close();
  }
  apply(sender: string, input: unknown): Receipt[] {
    check(sender.length > 0 && sender.length <= 512, "invalid authenticated sender");
    const changes = validateChanges(input);
    check(Buffer.byteLength(JSON.stringify(changes)) <= MAX_BATCH_BYTES, "batch too large", 413);
    return this.transaction(() => changes.map((change) => this.accept(sender, change)));
  }
  private accept(sender: string, change: SyncChange): Receipt {
    const body = canonical(change);
    const digest = createHash("sha256").update(body).digest("hex");
    const old = this.db
      .prepare("SELECT digest,body FROM receipts WHERE sender=? AND change_id=?")
      .get(sender, change.changeId);
    if (old) {
      check(old.digest === digest, "changeId reused with different content", 409);
      return JSON.parse(String(old.body)) as Receipt;
    }
    for (const asset of Object.values(change.record?.assets ?? {})) {
      const state = this.assetStatus(asset.sha256);
      check(
        state?.complete && state.size === asset.size,
        "referenced asset missing, incomplete or wrong size",
        409,
      );
    }
    const previousRevision = this.db
      .prepare("SELECT revision FROM revisions WHERE sender=? AND type=? AND id=?")
      .get(sender, change.id.type, change.id.id);
    const latest = this.db
      .prepare("SELECT * FROM latest WHERE type=? AND id=?")
      .get(change.id.type, change.id.id) as Latest | undefined;
    const tie = `${sender}:${change.changeId}`;
    // 同一发送者按 revision 而非墙钟排序，系统时钟回拨不丢较新本地修改。
    const wins =
      (!previousRevision || change.revision > Number(previousRevision.revision)) &&
      (!latest ||
        (latest.sender === sender && change.revision > latest.revision) ||
        (latest.sender !== sender &&
          (change.updatedAt > latest.changed ||
            (change.updatedAt === latest.changed &&
              ((change.operation === "delete" && latest.operation !== "delete") ||
                (change.operation === latest.operation && tie > latest.tie))))));
    let cursor = latest?.cursor ?? 0;
    if (wins) {
      cursor = Number(
        this.db.prepare("INSERT INTO changes(sender,body) VALUES (?,?)").run(sender, body)
          .lastInsertRowid,
      );
      this.db
        .prepare("INSERT OR REPLACE INTO latest VALUES (?,?,?,?,?,?,?,?)")
        .run(
          change.id.type,
          change.id.id,
          sender,
          change.revision,
          change.updatedAt,
          change.operation,
          tie,
          cursor,
        );
    }
    this.db
      .prepare(
        "INSERT INTO revisions VALUES (?,?,?,?) ON CONFLICT(sender,type,id) DO UPDATE SET revision=max(revision,excluded.revision)",
      )
      .run(sender, change.id.type, change.id.id, change.revision);
    const receipt: Receipt = {
      changeId: change.changeId,
      revision: change.revision,
      status: wins ? "stored" : "superseded",
      cursor,
    };
    this.db
      .prepare("INSERT INTO receipts VALUES (?,?,?,?)")
      .run(sender, change.changeId, digest, JSON.stringify(receipt));
    return receipt;
  }
  changes(after: number, limit: number) {
    check(
      Number.isSafeInteger(after) &&
        after >= 0 &&
        Number.isSafeInteger(limit) &&
        limit > 0 &&
        limit <= 100,
      "invalid cursor or limit",
    );
    const maximum = Number(
      this.db.prepare("SELECT coalesce(max(cursor),0) AS n FROM changes").get()!.n,
    );
    check(after <= maximum, "cursor belongs to another replica or future log", 409);
    const changes: Array<{ cursor: number; senderDeviceId: string; change: SyncChange }> = [];
    let bytes = 0;
    for (const r of this.db
      .prepare("SELECT cursor,sender,body FROM changes WHERE cursor>? ORDER BY cursor LIMIT ?")
      .iterate(after, limit)) {
      const length = Buffer.byteLength(String(r.body));
      if (changes.length > 0 && bytes + length > MAX_BATCH_BYTES) break;
      changes.push({
        cursor: Number(r.cursor),
        senderDeviceId: String(r.sender),
        change: JSON.parse(String(r.body)) as SyncChange,
      });
      bytes += length;
    }
    const nextCursor = changes.at(-1)?.cursor ?? after;
    return { replicaId: this.replicaId, changes, nextCursor, hasMore: nextCursor < maximum };
  }
  assetStatus(hash: string): AssetStatus | undefined {
    const row = this.db.prepare("SELECT * FROM assets WHERE hash=?").get(hash);
    return row
      ? { size: Number(row.size), offset: Number(row.offset), complete: row.complete === 1 }
      : undefined;
  }
  putAsset(
    hash: string,
    offset: number,
    size: number,
    bytes: Buffer,
    restart = false,
  ): AssetStatus {
    check(
      /^[a-f0-9]{64}$/.test(hash) &&
        Number.isSafeInteger(size) &&
        size >= 0 &&
        size <= MAX_ASSET &&
        Number.isSafeInteger(offset) &&
        offset >= 0 &&
        bytes.length <= MAX_CHUNK &&
        offset + bytes.length <= size &&
        (bytes.length > 0 || size === 0),
      "invalid asset chunk",
    );
    return this.transaction(() => {
      let old = this.assetStatus(hash);
      if (restart && old && !old.complete) {
        check(offset === 0, "asset restart requires offset zero");
        this.db.prepare("DELETE FROM assets WHERE hash=? AND complete=0").run(hash);
        old = undefined;
      }
      if (old?.complete) {
        check(old.size === size, "asset size conflict", 409);
        return old;
      }
      check(!old || old.size === size, "asset size conflict", 409);
      check(offset === (old?.offset ?? 0), "asset offset conflict", 409);
      this.db.prepare("INSERT OR IGNORE INTO assets(hash,size) VALUES (?,?)").run(hash, size);
      this.db.prepare("INSERT INTO chunks VALUES (?,?,?)").run(hash, offset, bytes);
      const next = offset + bytes.length;
      if (next === size) {
        const digest = createHash("sha256");
        for (const chunk of this.db
          .prepare("SELECT bytes FROM chunks WHERE hash=? ORDER BY offset")
          .iterate(hash))
          digest.update(chunk.bytes as Uint8Array);
        check(digest.digest("hex") === hash, "asset sha256 mismatch", 422);
      }
      this.db
        .prepare("UPDATE assets SET offset=?,complete=? WHERE hash=?")
        .run(next, next === size ? 1 : 0, hash);
      return { size, offset: next, complete: next === size };
    });
  }
  readAsset(hash: string, start: number, end: number): Buffer {
    const status = this.assetStatus(hash);
    check(status?.complete, "asset not found", 404);
    if (status.size === 0) return Buffer.alloc(0);
    check(
      Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        start >= 0 &&
        start <= end &&
        end < status.size,
      "invalid asset range",
      416,
    );
    const chunks = this.db
      .prepare(
        "SELECT offset,bytes FROM chunks WHERE hash=? AND offset<=? AND offset+length(bytes)>? ORDER BY offset",
      )
      .all(hash, end, start);
    return Buffer.concat(
      chunks.map((c) =>
        Buffer.from(c.bytes as Uint8Array).subarray(
          Math.max(0, start - Number(c.offset)),
          Math.min((c.bytes as Uint8Array).length, end - Number(c.offset) + 1),
        ),
      ),
    );
  }
  private transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
