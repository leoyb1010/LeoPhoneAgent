import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { resolveStorageRoots } from "../src/storage/adapters/rootsResolver.js";

// [leo] 数据根目录名是 .leophoneagent（rootsResolver.ts 的 ZCODE_DATA_DIR_NAME），不与官方 ~/.zcode 共用。
describe("resolveStorageRoots", () => {
  it("returns only the home root when the data base dir is the home dir", () => {
    expect(resolveStorageRoots({ homeDir: "/Users/u", dataBaseDir: "/Users/u/" })).toEqual([
      { id: "home", path: join(resolve("/Users/u"), ".leophoneagent"), hasCustomDataBaseDir: false },
    ]);
  });

  it("adds the custom data base dir root and flags the home root as having a stale v2 copy", () => {
    expect(
      resolveStorageRoots({ homeDir: "/Users/u", dataBaseDir: "/Volumes/Data/zcode" }),
    ).toEqual([
      { id: "home", path: join(resolve("/Users/u"), ".leophoneagent"), hasCustomDataBaseDir: true },
      {
        id: "dataBaseDir",
        path: join(resolve("/Volumes/Data/zcode"), ".leophoneagent"),
        hasCustomDataBaseDir: true,
      },
    ]);
  });
});
