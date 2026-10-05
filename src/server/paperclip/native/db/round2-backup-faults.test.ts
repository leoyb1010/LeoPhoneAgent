import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";
import postgres from "postgres";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { runDatabaseBackup } from "./backup-lib.js";
import { startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const run = promisify(execFile);
const loader = fileURLToPath(new URL("../../../server/node_modules/tsx/dist/loader.mjs", import.meta.url));
const backupModule = new URL("./backup-lib.ts", import.meta.url).href;

describe("round-two backup IO and recovery boundaries", () => {
  let directory: string;
  let database: EmbeddedPostgresTestDatabase;
  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pc-r2-bk-"));
    database = await startEmbeddedPostgresTestDatabase("pc-r2-bk-db-");
  }, 90000);
  afterAll(async () => {
    await database?.cleanup();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }, 30000);

  async function probe(operation: string, workspace: string, binary?: string, connectionString = database.connectionString) {
    const temporary = path.join(directory, `temporary-${operation}`);
    fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
    const script = path.join(directory, `probe-${operation}.mjs`);
    fs.writeFileSync(script, `
      import fs from "node:fs";
      import path from "node:path";
      import { setTimeout } from "node:timers/promises";
      import { createBufferedTextFileWriter, runDatabaseRestore } from ${JSON.stringify(backupModule)};
      const [operation, workspace] = process.argv.slice(2);
      try {
        if (operation.startsWith("writer")) {
          const writer = createBufferedTextFileWriter(path.join(workspace, "failure.sql"), 1);
          if (operation === "writer-pending") writer.emit("fixture pending write");
          await setTimeout(25);
          await writer.close();
        } else {
          await runDatabaseRestore({connectionString:process.env.R2_FIXTURE_DATABASE_URL,
            backupFile:path.join(workspace, operation === "missing" ? "missing.sql.gz" : "archive.sql.gz"),connectTimeoutSeconds:1});
        }
        console.log(JSON.stringify({caught:false}));
      } catch(error) { console.log(JSON.stringify({caught:true,code:error.code ?? null})); }
    `);
    const child = await run(process.execPath, ["--import", loader, script, operation, workspace], {
      env: { ...process.env, TMPDIR: temporary, R2_FIXTURE_DATABASE_URL: connectionString, ...(binary ? { PAPERCLIP_PSQL_PATH: binary } : {}) },
      timeout: 15000,
    });
    expect(fs.readdirSync(temporary).filter(name => name.startsWith("paperclip-restore-"))).toEqual([]);
    return child;
  }

  it("keeps the process alive and preserves EACCES when file-open rejection precedes a delayed consumer", async () => {
    const denied = path.join(directory, "denied");
    fs.mkdirSync(denied); fs.chmodSync(denied, 0o500);
    try {
      const child = await probe("writer", denied);
      expect(JSON.parse(child.stdout.trim())).toEqual({ caught: true, code: "EACCES" });
      expect(child.stderr).toBe("");
    } finally { fs.chmodSync(denied, 0o700); }
  });

  it("observes a queued write rejection before its delayed consumer without losing EACCES", async () => {
    const denied = path.join(directory, "denied-pending");
    fs.mkdirSync(denied); fs.chmodSync(denied, 0o500);
    try {
      const child = await probe("writer-pending", denied);
      expect(JSON.parse(child.stdout.trim())).toEqual({ caught: true, code: "EACCES" });
      expect(child.stderr).toBe("");
    } finally { fs.chmodSync(denied, 0o700); }
  });

  it("keeps missing compressed input errors inside the restore promise", async () => {
    const binary = path.join(directory, "fake-psql");
    fs.writeFileSync(binary, "#!/bin/sh\n/bin/cat >/dev/null\nexit 7\n", { mode: 0o700 });
    const child = await probe("missing", directory, binary);
    expect(JSON.parse(child.stdout.trim())).toEqual({ caught: true, code: "ENOENT" });
    expect(child.stderr).not.toContain("Unhandled 'error' event");
  });

  it.each(["truncated", "bad-crc"])("rejects %s compression before changing a populated isolated target", async kind => {
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe("DROP TABLE IF EXISTS round2_restore_marker; CREATE TABLE round2_restore_marker (body text NOT NULL); INSERT INTO round2_restore_marker VALUES ('before')");
      const workspace = path.join(directory, kind); fs.mkdirSync(workspace);
      const marker = "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900";
      const text = `BEGIN;\n${marker}\nUPDATE round2_restore_marker SET body='after';\n${marker}\nCOMMIT;\n${marker}\n-- ${randomBytes(128 * 1024).toString("hex")}\n`;
      const complete = gzipSync(text);
      const damaged = kind === "truncated" ? complete.subarray(0, complete.length - 8) : Buffer.from(complete);
      if (kind === "bad-crc") damaged[damaged.length - 8] ^= 0xff;
      fs.writeFileSync(path.join(workspace, "archive.sql.gz"), damaged);
      const child = await probe(kind, workspace, "/opt/homebrew/opt/postgresql@17/bin/psql");
      expect(JSON.parse(child.stdout.trim()).caught).toBe(true);
      expect(await sql.unsafe("SELECT body FROM round2_restore_marker").then(rows => rows.map(row => row.body))).toEqual(["before"]);
    } finally { await sql.end(); }
  }, 30000);

  it("restores a fully valid compressed snapshot and removes its private temporary file", async () => {
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe("DROP TABLE IF EXISTS round2_restore_marker; CREATE TABLE round2_restore_marker (body text NOT NULL); INSERT INTO round2_restore_marker VALUES ('before')");
      const workspace = path.join(directory, "valid"); fs.mkdirSync(workspace);
      fs.writeFileSync(path.join(workspace, "archive.sql.gz"), gzipSync("UPDATE round2_restore_marker SET body='after';\n"));
      const child = await probe("valid", workspace, "/opt/homebrew/opt/postgresql@17/bin/psql");
      expect(JSON.parse(child.stdout.trim())).toEqual({ caught: false });
      expect(await sql.unsafe("SELECT body FROM round2_restore_marker").then(rows => rows.map(row => row.body))).toEqual(["after"]);
    } finally { await sql.end(); }
  }, 30000);

  it("preserves independently valid artifacts for two concurrent backups started in the same second", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-05T06:00:00Z"));
    try {
      const options = { connectionString: database.connectionString, backupDir: path.join(directory, "parallel"),
        backupEngine: "javascript" as const, retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 2 } };
      const results = await Promise.all([runDatabaseBackup(options), runDatabaseBackup(options)]);
      expect(new Set(results.map(row => row.backupFile)).size).toBe(2);
      for (const row of results) expect(gunzipSync(fs.readFileSync(row.backupFile)).toString()).toContain("COMMIT;");
    } finally { vi.useRealTimers(); }
  }, 60000);

  it("rejects an unusable backup directory without damaging earlier recovery artifacts", async () => {
    const prior = path.join(directory, "accepted.sql.gz"); const bytes = gzipSync("fixture accepted backup");
    fs.writeFileSync(prior, bytes);
    const notDirectory = path.join(directory, "not-a-directory"); fs.writeFileSync(notDirectory, "fixture");
    await expect(runDatabaseBackup({ connectionString: database.connectionString, backupDir: notDirectory,
      backupEngine: "javascript", retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 2 } })).rejects.toMatchObject({ code: "EEXIST" });
    expect(fs.readFileSync(prior)).toEqual(bytes);
  });
});
