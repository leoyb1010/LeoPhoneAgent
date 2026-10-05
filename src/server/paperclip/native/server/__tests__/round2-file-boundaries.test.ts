import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { workspaceFileResourceService, WORKSPACE_FILE_TEXT_MAX_BYTES } from "../services/workspace-file-resources.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("round-two file content and encoding boundaries", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let directory: string;
  let issueId: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("pc-r2-files-");
    db = createDb(database.connectionString);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "pc-r2-content-"));
    const [company] = await db.insert(companies).values({ name: "File boundary fixture", issuePrefix: "R2FILE" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company!.id, name: "Fixture files" }).returning();
    const [workspace] = await db.insert(projectWorkspaces).values({ companyId: company!.id, projectId: project!.id,
      name: "Fixture workspace", sourceType: "local_path", cwd: directory, isPrimary: true }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company!.id, projectId: project!.id, projectWorkspaceId: workspace!.id,
      title: "File boundary fixture", status: "todo", priority: "medium" }).returning();
    issueId = issue!.id;
  }, 90000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await database?.cleanup(); if (directory) await fs.rm(directory, { recursive: true, force: true }); }, 30000);
  const read = (file: string) => workspaceFileResourceService(db).readContent(issueId, { workspace: "project", path: file });

  it("caps bytes actually read when a regular file grows after its first descriptor stat", async () => {
    const file = path.join(directory, "growing.txt");
    await fs.writeFile(file, "small fixture");
    const originalOpen = fs.open.bind(fs);
    let observedBytes = 0;
    let grew = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) !== file) return handle;
      const stat = handle.stat.bind(handle);
      const readFile = handle.readFile.bind(handle);
      const readChunk = handle.read.bind(handle);
      handle.stat = (async (...values: Parameters<typeof handle.stat>) => {
        const snapshot = await stat(...values);
        if (!grew) { grew = true; await fs.appendFile(file, Buffer.alloc(WORKSPACE_FILE_TEXT_MAX_BYTES * 2, "x")); }
        return snapshot;
      }) as typeof handle.stat;
      handle.readFile = (async (...values: Parameters<typeof handle.readFile>) => {
        const data = await readFile(...values);
        observedBytes += Buffer.byteLength(data);
        return data;
      }) as typeof handle.readFile;
      handle.read = (async (...values: Parameters<typeof handle.read>) => {
        const value = await readChunk(...values);
        observedBytes += value.bytesRead;
        return value;
      }) as typeof handle.read;
      return handle;
    });
    const error = await read("growing.txt").then(() => null, error => error);
    expect(error).toMatchObject({ status: 422, details: { code: "too_large" } });
    expect(observedBytes).toBeLessThanOrEqual(WORKSPACE_FILE_TEXT_MAX_BYTES + 1);
  });

  it("treats encoded dot/slash names literally and does not decode them a second time", async () => {
    const encoded = "%2e%2e%2foutside.txt";
    await fs.writeFile(path.join(directory, encoded), "literal encoded filename");
    expect((await read(encoded)).content.data).toBe("literal encoded filename");
    for (const value of ["../outside.txt", "..\\outside.txt", "file:///outside.txt", "C:/outside.txt", "safe/../../outside.txt", "safe\u0000name"]) {
      await expect(read(value)).rejects.toMatchObject({ status: expect.any(Number) });
    }
  });

  it("accepts the exact UTF-8 byte ceiling and rejects the next byte", async () => {
    const exact = Buffer.from("😀".repeat(WORKSPACE_FILE_TEXT_MAX_BYTES / 4));
    await fs.writeFile(path.join(directory, "exact.txt"), exact);
    expect(Buffer.byteLength((await read("exact.txt")).content.data)).toBe(WORKSPACE_FILE_TEXT_MAX_BYTES);
    await fs.writeFile(path.join(directory, "over.txt"), Buffer.concat([exact, Buffer.from("x")]));
    await expect(read("over.txt")).rejects.toMatchObject({ status: 422, details: { code: "too_large" } });
  });

  it("does not preview executable HTML or sensitive files while returning SVG as source text", async () => {
    await fs.writeFile(path.join(directory, "page.html"), "<script>fixture</script>");
    await fs.writeFile(path.join(directory, ".env"), "fixture-only-value");
    await fs.writeFile(path.join(directory, "image.svg"), "<svg><text>fixture</text></svg>");
    await expect(read("page.html")).rejects.toMatchObject({ status: 422 });
    await expect(read(".env")).rejects.toMatchObject({ status: 403 });
    const svg = await read("image.svg");
    expect(svg.resource.previewKind).toBe("text");
    expect(svg.content.encoding).toBe("utf8");
  });
});
