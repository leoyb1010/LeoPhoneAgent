import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertCompanyAccess } from "../routes/authz.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

describe("round-one external input and identity counterexamples", () => {
  const temporary: string[] = [];
  afterEach(async () => {
    for (const directory of temporary.splice(0)) await fs.rm(directory, { recursive: true, force: true });
  });
  async function directory() {
    const value = await fs.mkdtemp(path.join(os.tmpdir(), "pc-bound-r1-"));
    temporary.push(value);
    return value;
  }

  it.each(["../outside", "/outside", "company-a/../../outside", "company-a\\..\\outside", "company-a/./outside"])
    ("rejects raw object traversal %s without creating files", async (objectKey) => {
      const root = await directory();
      const provider = createLocalDiskStorageProvider(root);
      await expect(provider.putObject({ objectKey, body: Buffer.from("fixture"), contentType: "text/plain", contentLength: 7 }))
        .rejects.toMatchObject({ status: 400 });
      expect(await fs.readdir(root)).toEqual([]);
    });

  it.each(["company-a-else/file", "company-A/file", "company-b/file", "company-a\\file"])
    ("rejects foreign or lookalike company prefix %s", async (objectKey) => {
      const root = await directory();
      const service = createStorageService(createLocalDiskStorageProvider(root));
      await expect(service.getObject("company-a", objectKey)).rejects.toMatchObject({ status: 403 });
      await expect(service.deleteObject("company-a", objectKey)).rejects.toMatchObject({ status: 403 });
      expect(await fs.readdir(root)).toEqual([]);
    });

  it.each(["../../sensitive.txt", "C:\\Windows\\sensitive.txt", "quoted\"\r\nfilename.txt"])
    ("keeps attacker-controlled filenames within the company namespace: %s", async (originalFilename) => {
      const root = await directory();
      const service = createStorageService(createLocalDiskStorageProvider(root));
      const stored = await service.putFile({ companyId: "company-a", namespace: "uploads", originalFilename,
        contentType: "text/plain", body: Buffer.from("fixture") });
      expect(stored.objectKey.startsWith("company-a/uploads/")).toBe(true);
      expect(stored.objectKey).not.toMatch(/[\\\r\n]/);
      expect(await fs.readFile(path.join(root, stored.objectKey), "utf8")).toBe("fixture");
      await expect(service.getObject("company-b", stored.objectKey)).rejects.toMatchObject({ status: 403 });
    });

  it.each(["POST", "PATCH", "DELETE", "TRACE"])("rejects viewer %s before a company mutation", (method) => {
    const req = { method, actor: { type: "board", source: "session", companyIds: ["company-a"],
      memberships: [{ companyId: "company-a", membershipRole: "viewer", status: "active" }] } } as Express.Request;
    expect(() => assertCompanyAccess(req, "company-a")).toThrow("Viewer access is read-only");
  });

  it("rejects delegated agent access after responsible membership disappears", () => {
    const req = { method: "GET", actor: { type: "agent", source: "agent_jwt", companyId: "company-a", agentId: "fixture-agent",
      onBehalfOfUserId: "fixture-user", onBehalfOfMemberships: [] } } as Express.Request;
    expect(() => assertCompanyAccess(req, "company-a")).toThrow("Responsible user is unavailable for this company");
  });
});
