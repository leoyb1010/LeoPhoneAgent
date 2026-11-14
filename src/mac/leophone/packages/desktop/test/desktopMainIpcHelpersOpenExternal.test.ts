import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fixtureDir: string;
let fixtureFile: string;
beforeEach(() => {
  fixtureDir = realpathSync(mkdtempSync(join(tmpdir(), "leo-open-file-")));
  fixtureFile = join(fixtureDir, "04 素材 preview page.html");
  writeFileSync(fixtureFile, "<!doctype html><title>fixture</title>");
});
afterEach(() => rmSync(fixtureDir, { recursive: true, force: true }));

const h = vi.hoisted(() => ({
  shellOpenPath: vi.fn(),
}));

vi.mock("electron", () => ({
  shell: {
    openPath: h.shellOpenPath,
  },
}));

describe("openPathInDefaultApp", () => {
  beforeEach(() => {
    h.shellOpenPath.mockReset();
  });

  it("uses shell.openPath for a local HTML file and reports success", async () => {
    h.shellOpenPath.mockResolvedValue("");
    const { openPathInDefaultApp } = await import("../src/main/desktopMainIpcHelpers.js");
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await openPathInDefaultApp(fixtureFile, logger);

    expect(h.shellOpenPath).toHaveBeenCalledWith(fixtureFile);
    expect(result).toEqual({ success: true });
    expect(logger.info).toHaveBeenCalledWith("[open-external] 本地文件打开成功", {
      path: fixtureFile,
    });
  });

  it("returns and logs the shell error instead of failing silently", async () => {
    h.shellOpenPath.mockResolvedValue("No application is associated with the specified file");
    const { openPathInDefaultApp } = await import("../src/main/desktopMainIpcHelpers.js");
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await openPathInDefaultApp(fixtureFile, logger);

    expect(result).toEqual({
      success: false,
      error: "No application is associated with the specified file",
    });
    expect(logger.warn).toHaveBeenCalledWith("[open-external] 本地文件打开失败", {
      path: fixtureFile,
      error: "No application is associated with the specified file",
    });
  });
});
