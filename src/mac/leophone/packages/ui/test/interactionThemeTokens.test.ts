import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("packages/ui/src/styles.css", "utf8");

describe("blocking interaction theme tokens", () => {
  it("uses the same blue interaction palette across every supported theme", () => {
    const tokens = [
      "--color-interaction-ask-surface",
      "--color-interaction-ask-foreground",
      "--color-interaction-ask-fill",
      "--color-interaction-confirmation-surface",
      "--color-interaction-confirmation-foreground",
    ];

    for (const token of tokens) {
      expect(styles.match(new RegExp(`${token}:`, "g"))).toHaveLength(4);
    }
    expect(styles.match(/--color-interaction-confirmation-surface: var\(--color-interaction-ask-surface\);/g)).toHaveLength(4);
    expect(styles.match(/--color-interaction-confirmation-foreground: var\(--color-interaction-ask-foreground\);/g)).toHaveLength(4);
    expect(styles.match(/--color-interaction-ask-fill: color-mix\(in oklab, var\(--color-interaction-ask-foreground\) 22%, transparent\);/g)).toHaveLength(4);
  });
});
