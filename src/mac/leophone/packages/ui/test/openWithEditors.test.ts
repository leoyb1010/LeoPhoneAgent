import { describe, expect, it } from "vitest";
import type { EditorInfo } from "@zcode/shared";
import { sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";

function makeEditor(id: string): EditorInfo {
  return {
    id,
    name: id,
    iconDataUrl: `data:image/png;base64,${id}`,
  };
}

describe("open-with editor ordering", () => {
  // [leo] Mac 1.9 删除了界面模式（通用/办公模式）及 isFileManagerOpenTarget，对应用例已移除。
  it("pins file managers before regular editors in a stable shared order", () => {
    const sortedEditors = sortInstalledEditorsForOpenWith([
      makeEditor("cursor"),
      makeEditor("qspace-pro"),
      makeEditor("vscode"),
      makeEditor("explorer"),
      makeEditor("qspace"),
      makeEditor("finder"),
    ]);

    expect(sortedEditors.map((editor) => editor.id)).toEqual([
      "finder",
      "qspace",
      "qspace-pro",
      "explorer",
      "cursor",
      "vscode",
    ]);
  });
});
