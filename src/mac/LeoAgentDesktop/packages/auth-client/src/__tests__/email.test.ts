import { describe, expect, it } from "vitest";

import { isValidEmail } from "../index.js";

describe("isValidEmail", () => {
  it("accepts well-formed addresses", () => {
    for (const ok of [
      "a@b.co",
      "sam@example.com",
      "user.name+tag@sub.domain.io",
      "USER@EXAMPLE.COM",
      "x_y@z-w.com",
    ]) {
      expect(isValidEmail(ok)).toBe(true);
    }
  });

  it("rejects the design's malformed samples and other bad shapes", () => {
    for (const bad of [
      "2222@", // figma 347:1727 反例：@ 后无 domain
      "Sam@", // 同上
      "", // 空
      "   ", // 纯空白
      "plainstring", // 无 @
      "@example.com", // 无 local 段
      "user@domain", // 无点分 TLD
      "user@domain.", // TLD 空
      "user@@example.com", // 双 @
      "user @example.com", // 含空白
      "user@ex ample.com", // domain 含空白
    ]) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });

  it("trims surrounding whitespace before judging", () => {
    expect(isValidEmail("  sam@example.com  ")).toBe(true);
    expect(isValidEmail("\tuser@ex.io\n")).toBe(true);
  });
});
