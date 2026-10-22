import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectZCodeSkill, listZCodeSkills } from "../src/skills.js";

describe("inspectZCodeSkill", () => {
  // 用户级 skill 根取 os.homedir()（~/.leophoneagent/skills、~/.agents/skills）；不隔离 HOME 时
  // 开发机家目录里的技能（含格式不合规的）会混进 diagnostics，结果依赖机器。
  let home = "";
  let prevHome: string | undefined;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "zcode-bootstrap-skill-home-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(home, { force: true, recursive: true });
  });

  it("loads one discovered skill through the configured skill adapter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-bootstrap-skill-"));
    const skillDir = join(dir, ".zcode", "skills", "demo");

    try {
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: demo",
          "description: Use for demo tasks.",
          "when_to_use: When inspecting skill commands.",
          "---",
          "",
          "# Demo Skill",
          "Follow this workflow.",
        ].join("\n"),
      );

      const inspection = await inspectZCodeSkill({
        env: {},
        name: "demo",
        skipUserConfig: true,
        workingDirectory: dir,
      });

      expect(inspection.diagnostics).toEqual([]);
      expect(inspection.skill.metadata.name).toBe("demo");
      expect(inspection.skill.metadata.whenToUse).toBe("When inspecting skill commands.");
      expect(inspection.skill.content).toContain("# Demo Skill");
      expect(inspection.skill.content).not.toContain("description:");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("returns a stable missing-skill error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-bootstrap-skill-missing-"));

    try {
      await expect(
        inspectZCodeSkill({
          env: {},
          name: "missing",
          skipUserConfig: true,
          workingDirectory: dir,
        }),
      ).rejects.toThrow("Skill not found: missing");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("discovers the built-in dynamic-workflows skill as a bundled system skill, outside any plugin", async () => {
    // 2026-09-19 事故：技能住在可卸载的 zcode-guide 插件里，插件一停用技能就没了。现在它来自
    // packages/bundled-skills（bootstrap/src/app/bundled-skills.ts），与插件启停无关。
    const dir = await mkdtemp(join(tmpdir(), "zcode-bootstrap-bundled-skill-"));

    try {
      const outcome = await listZCodeSkills({
        env: { ZCODE_STORAGE_DIR: join(dir, "storage") },
        skipUserConfig: true,
        workingDirectory: dir,
      });
      const skill = outcome.skills.find((entry) => entry.name === "dynamic-workflows");

      expect(skill).toMatchObject({ scope: "system", source: "bundled" });
      expect(skill?.pluginName).toBeUndefined();
      expect(skill?.qualifiedName).toBeUndefined();
      expect(
        skill?.path.endsWith(join("bundled-skills", "skills", "dynamic-workflows", "SKILL.md")),
      ).toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  // [leo] 文档四件套（docx/pdf/pptx/xlsx）不随包；默认启用的随包内容插件是 browser-use。
  // superpowers 随包但默认关闭（P1 首轮提速），在项目配置里显式开启后其技能才可见。
  it("discovers bundled content skills through default-enabled official plugins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-bootstrap-document-skills-"));

    try {
      const env = { ZCODE_STORAGE_DIR: join(dir, "storage") };
      const bundledSkillNames = (skills: { name: string }[]) =>
        skills
          .filter((skill) =>
            ["control-browser", "docx", "pdf", "pptx", "using-superpowers", "web-gui-tester", "xlsx"].includes(
              skill.name,
            ),
          )
          .map((skill) => skill.name)
          .toSorted();
      const outcome = await listZCodeSkills({
        env,
        skipUserConfig: true,
        workingDirectory: dir,
      });
      const bundledSkills = outcome.skills.filter((skill) =>
        ["control-browser", "web-gui-tester"].includes(skill.name),
      );

      expect(bundledSkillNames(outcome.skills)).toEqual(["control-browser", "web-gui-tester"]);
      expect(bundledSkills.map((skill) => skill.scope)).toEqual(["system", "system"]);
      expect(bundledSkills.map((skill) => skill.source)).toEqual(["plugin", "plugin"]);
      expect(outcome.diagnostics).toEqual([]);

      await mkdir(join(dir, ".zcode"), { recursive: true });
      await writeFile(
        join(dir, ".zcode", "config.json"),
        JSON.stringify({
          plugins: { enabledPlugins: { "superpowers@zcode-plugins-official": true } },
        }),
      );
      const enabledOutcome = await listZCodeSkills({
        env,
        skipUserConfig: true,
        workingDirectory: dir,
      });
      expect(bundledSkillNames(enabledOutcome.skills)).toEqual([
        "control-browser",
        "using-superpowers",
        "web-gui-tester",
      ]);

      const superpowersInspection = await inspectZCodeSkill({
        env,
        name: "using-superpowers",
        skipUserConfig: true,
        workingDirectory: dir,
      });
      expect(superpowersInspection.skill.content).toContain("SUBAGENT-STOP");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
