import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { copyNoticeFiles, noticeSource } =
  require("../../plugins/with-third-party-notices.js") as {
    copyNoticeFiles: (
      projectRoot: string,
      platform: "ios" | "android",
      destination: string,
    ) => void;
    noticeSource: (
      projectRoot: string,
      platform: "ios" | "android",
      destination: string,
    ) => string;
  };

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "xdmaker-third-party-notices-"),
  );
  fixtures.push(root);
  const projectRoot = path.join(root, "apps", "mobile");
  const notices = path.join(root, "docs", "legal", "notices");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(notices, { recursive: true });
  fs.writeFileSync(path.join(notices, "mobile-ios.txt"), "ios notice\n");
  fs.writeFileSync(
    path.join(notices, "mobile-android.txt"),
    "android notice\n",
  );
  fs.writeFileSync(
    path.join(notices, "mobile-ios-restricted.txt"),
    "ios restricted\n",
  );
  fs.writeFileSync(
    path.join(notices, "mobile-android-restricted.txt"),
    "android restricted\n",
  );
  return { root, projectRoot };
}

describe("with-third-party-notices config plugin helpers", () => {
  it("selects and copies the platform-specific notice plus restricted disclosure", () => {
    const fixture = createFixture();
    const destination = path.join(fixture.root, "native-resources");

    copyNoticeFiles(fixture.projectRoot, "ios", destination);

    expect(
      fs.readFileSync(
        path.join(destination, "THIRD-PARTY-NOTICES.txt"),
        "utf8",
      ),
    ).toBe("ios notice\n");
    expect(
      fs.readFileSync(
        path.join(destination, "THIRD-PARTY-RESTRICTED.txt"),
        "utf8",
      ),
    ).toBe("ios restricted\n");
    expect(
      noticeSource(fixture.projectRoot, "android", "THIRD-PARTY-NOTICES.txt"),
    ).toBe(
      path.join(fixture.root, "docs", "legal", "notices", "mobile-android.txt"),
    );
  });

  it("fails prebuild when generated notices are missing", () => {
    const fixture = createFixture();
    fs.rmSync(
      path.join(fixture.root, "docs", "legal", "notices", "mobile-android.txt"),
    );

    expect(() =>
      copyNoticeFiles(
        fixture.projectRoot,
        "android",
        path.join(fixture.root, "native-resources"),
      ),
    ).toThrow(/run pnpm licenses:generate/);
  });

  it("uses Android resource-compatible lowercase filenames", () => {
    const fixture = createFixture();
    const destination = path.join(fixture.root, "native-resources");

    copyNoticeFiles(fixture.projectRoot, "android", destination);

    expect(
      fs.readFileSync(
        path.join(destination, "third_party_notices.txt"),
        "utf8",
      ),
    ).toBe("android notice\n");
    expect(
      fs.readFileSync(
        path.join(destination, "third_party_restricted.txt"),
        "utf8",
      ),
    ).toBe("android restricted\n");
  });
});
