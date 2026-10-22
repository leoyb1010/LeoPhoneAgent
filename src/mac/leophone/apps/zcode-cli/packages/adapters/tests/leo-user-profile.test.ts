// [leo] 用户画像文件 ~/.leophoneagent/leo-profile.md 的读取（docs/specs/leo-profile-card.md）。

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createNodeContextSourceAdapter } from "../src/context/index.js";

const envInfo = {
  cwd: "/work/project",
  platform: "darwin",
  shell: "zsh",
  osVersion: "Darwin 25",
  nodeVersion: "v24",
};

test("context source reads leo-profile.md, strips the sync header, only for main sessions", async () => {
  const home = await mkdtemp(join(tmpdir(), "leo-profile-home-"));
  const work = await mkdtemp(join(tmpdir(), "leo-profile-work-"));
  try {
    await mkdir(join(home, ".leophoneagent"), { recursive: true });
    await writeFile(
      join(home, ".leophoneagent", "leo-profile.md"),
      "<!-- 由 iPhone 同步，勿手改 -->\n<!-- leo-profile id=abc version=2 -->\n\n喜欢简洁回答\n",
    );
    const adapter = createNodeContextSourceAdapter({ env: { HOME: home } });
    const main = await adapter.resolveContextSources({
      workingDirectory: work,
      envInfo,
      userInstructions: { workingDirectory: work },
    });
    expect(main.userProfile).toEqual({
      filePath: join(home, ".leophoneagent", "leo-profile.md"),
      content: "喜欢简洁回答",
    });
    const child = await adapter.resolveContextSources({ workingDirectory: work, envInfo });
    expect(child.userProfile).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test("missing or header-only profile file injects nothing", async () => {
  const home = await mkdtemp(join(tmpdir(), "leo-profile-empty-"));
  try {
    const adapter = createNodeContextSourceAdapter({ env: { HOME: home } });
    const request = { workingDirectory: home, envInfo, userInstructions: { workingDirectory: home } };
    expect((await adapter.resolveContextSources(request)).userProfile).toBeUndefined();
    await mkdir(join(home, ".leophoneagent"), { recursive: true });
    await writeFile(join(home, ".leophoneagent", "leo-profile.md"), "<!-- 由 iPhone 同步，勿手改 -->\n");
    expect((await adapter.resolveContextSources(request)).userProfile).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
