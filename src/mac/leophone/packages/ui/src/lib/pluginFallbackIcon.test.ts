import { describe, expect, it } from "vitest";
import { pluginInitial } from "./pluginFallbackIcon.js";

describe("pluginInitial", () => {
  it("uses the first character of the plugin name", () => {
    expect(pluginInitial("superpowers")).toBe("S");
    expect(pluginInitial("飞书助手")).toBe("飞");
    expect(pluginInitial("  ")).toBeUndefined();
    expect(pluginInitial(undefined)).toBeUndefined();
  });
});
