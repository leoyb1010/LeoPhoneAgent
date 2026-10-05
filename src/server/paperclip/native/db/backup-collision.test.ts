import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { runDatabaseBackup, runDatabaseRestore } from "./backup-lib.js";
import { ensurePostgresDatabase } from "./client.js";
import { startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

describe("backup admission failure preserves prior recovery artifacts", () => {
  let database: EmbeddedPostgresTestDatabase;
  let directory: string;
  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pc-backup-r1-"));
    database = await startEmbeddedPostgresTestDatabase("pc-backup-r1-db-");
  }, 90000);
  afterAll(async () => {
    await database?.cleanup();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }, 30000);

  it("retains a successful backup when the next backup in the same second fails", async () => {
    const source = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await source.unsafe("CREATE TABLE boundary_backup_marker (id integer PRIMARY KEY, body text NOT NULL)");
      await source.unsafe("INSERT INTO boundary_backup_marker VALUES (1, 'retained fixture data')");
    } finally { await source.end(); }
    const restoreURL = new URL(database.connectionString);
    restoreURL.pathname = "/round1_backup_restore";
    const adminURL = new URL(database.connectionString);
    adminURL.pathname = "/postgres";
    await ensurePostgresDatabase(adminURL.toString(), "round1_backup_restore");
    const priorBinary = process.env.PAPERCLIP_PG_DUMP_PATH;
    const failingBinary = path.join(directory, "failing-pg-dump");
    fs.writeFileSync(failingBinary, "#!/bin/sh\nexit 9\n", { mode: 0o700 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T01:00:00.000Z"));
    const options = {
      connectionString: database.connectionString,
      backupDir: path.join(directory, "backups"),
      filenamePrefix: "fixture",
      retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 2 },
    };
    try {
      const accepted = await runDatabaseBackup({ ...options, backupEngine: "javascript" });
      const acceptedBytes = fs.readFileSync(accepted.backupFile);
      expect(acceptedBytes.length).toBeGreaterThan(0);
      process.env.PAPERCLIP_PG_DUMP_PATH = failingBinary;
      await expect(runDatabaseBackup({ ...options, backupEngine: "pg_dump" })).rejects.toThrow("exit code 9");
      expect(fs.existsSync(accepted.backupFile)).toBe(true);
      expect(fs.readFileSync(accepted.backupFile)).toEqual(acceptedBytes);
      expect(fs.readdirSync(options.backupDir).filter(name => name.endsWith(".sql.gz")))
        .toEqual([path.basename(accepted.backupFile)]);
      await runDatabaseRestore({ connectionString: restoreURL.toString(), backupFile: accepted.backupFile });
      const restored = postgres(restoreURL.toString(), { max: 1, onnotice: () => {} });
      try {
        expect(await restored.unsafe("SELECT id, body FROM boundary_backup_marker"))
          .toEqual([{ id: 1, body: "retained fixture data" }]);
      } finally { await restored.end(); }
    } finally {
      vi.useRealTimers();
      if (priorBinary === undefined) delete process.env.PAPERCLIP_PG_DUMP_PATH;
      else process.env.PAPERCLIP_PG_DUMP_PATH = priorBinary;
    }
  }, 60000);
});
