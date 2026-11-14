import { describe, expect, it } from "vitest";
import {
  appendLeoDraftPrompt,
  LEO_WORKBENCH_STARTERS,
  canApplyLeoComposerInsert,
} from "@/leo/leoWorkbenchPrompts.js";

describe("Workbench starter and refine prompts", () => {
  it("routes a refinement to exactly its focused task, while legacy prefills remain draft-only", () => {
    expect(canApplyLeoComposerInsert({}, null, true)).toBe(true);
    expect(canApplyLeoComposerInsert({}, "task-a", true)).toBe(false);
    expect(canApplyLeoComposerInsert({ targetSessionId: "task-a" }, "task-a", true)).toBe(true);
    expect(canApplyLeoComposerInsert({ targetSessionId: "task-a" }, "task-b", true)).toBe(false);
    expect(canApplyLeoComposerInsert({ targetSessionId: "task-a" }, null, true)).toBe(false);
    expect(canApplyLeoComposerInsert({ targetSessionId: "task-a" }, "task-a", false)).toBe(false);
  });
  it("preserves user input and makes repeated insertion idempotent", () => {
    const current = "先保留我写的要求\n[能力](plugin://my-plugin)";
    const addition = "请继续修改 report.html";
    const merged = appendLeoDraftPrompt(current, addition);
    expect(merged).toBe(`${current}\n\n${addition}`);
    expect(appendLeoDraftPrompt(merged, addition)).toBe(merged);
    expect(appendLeoDraftPrompt("", addition)).toBe(addition);
    expect(appendLeoDraftPrompt(current, " ")).toBe(current);
  });
  it("offers three concrete starting jobs without submitting or claiming completed work", () => {
    expect(LEO_WORKBENCH_STARTERS.map((item) => item.id)).toEqual(["html", "code", "research"]);
    expect(LEO_WORKBENCH_STARTERS[0].prompt).toContain("真实可运行文件");
    expect(LEO_WORKBENCH_STARTERS[0].prompt).toContain("不引用外部");
  });
});
