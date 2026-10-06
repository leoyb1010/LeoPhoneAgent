import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const home = await mkdtemp(path.join(os.tmpdir(), "leo-settings-"));
process.env["ZCODE_DESKTOP_HOME_DIR"] = home;
const dir = path.join(home, ".leophoneagent", "v2");
const file = path.join(dir, "setting.json");
const { createSettingService } = await import("../src/setting/settingService.js");

test.after(() => rm(home, { recursive: true, force: true }));

test("a schema-invalid settings file is backed up before defaults are written over it", async () => {
  await mkdir(dir, { recursive: true });
  const original = JSON.stringify({ recentProjects: "not-an-array", note: "user data" });
  await writeFile(file, original);
  const service = createSettingService();
  await service.update({ recentProjects: ["/tmp/a"] });
  const backups = (await readdir(dir)).filter((name) => name.startsWith("setting.json.corrupt-"));
  assert.equal(backups.length, 1, "原文件必须留一份备份");
  assert.equal(await readFile(path.join(dir, backups[0]!), "utf8"), original);
  await rm(dir, { recursive: true, force: true });
});

test("an unreadable settings file is never overwritten with defaults", async () => {
  // 读失败(这里用同名目录制造 EISDIR)时手里只有默认值。
  await mkdir(file, { recursive: true });
  await writeFile(path.join(file, "keep"), "x");
  const service = createSettingService();
  await assert.rejects(service.update({ recentProjects: ["/tmp/a"] }), /refusing to overwrite/);
  assert.equal(await readFile(path.join(file, "keep"), "utf8"), "x");
  await rm(dir, { recursive: true, force: true });
});
