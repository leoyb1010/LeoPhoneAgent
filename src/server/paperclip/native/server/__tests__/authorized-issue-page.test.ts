import { describe, expect, it } from "vitest";
import { authorizedIssuePage } from "../services/authorized-issue-page.js";

describe("bounded authorized issue pages", () => {
  it("backfills visible rows and applies visible offset without returning candidate cursor metadata", async () => {
    const source = Array.from({ length: 340 }, (_, index) => ({ id: String(index).padStart(4, "0"), visible: index >= 300 }));
    const rows = await authorizedIssuePage({ limit: 3, offset: 2, keyset: true,
      read: async ({ afterId, limit }) => source.filter(row => afterId === undefined || row.id > afterId).slice(0, limit),
      authorize: async rows => rows.filter(row => row.visible) });
    expect(rows.map(row => row.id)).toEqual(["0302", "0303", "0304"]);
  });
  it("returns an empty complete page only after a truly exhausted hidden candidate set", async () => {
    let reads = 0;
    const rows = await authorizedIssuePage({ limit: 2, offset: 0, keyset: false, batchSize: 3,
      read: async ({ offset, limit }) => { reads++; return Array.from({ length: Math.min(limit, Math.max(0, 5 - offset)) }, (_, n) => ({ id: String(offset + n) })); },
      authorize: async () => [] });
    expect(rows).toEqual([]);
    expect(reads).toBe(2);
  });
  it("fails with generic 503 at the work cap instead of returning a false empty or partial page", async () => {
    let reads = 0;
    await expect(authorizedIssuePage({ limit: 2, offset: 0, keyset: false, batchSize: 2, maxCandidates: 4,
      read: async ({ offset }) => { reads++; return [{ id: String(offset) }, { id: String(offset + 1) }]; },
      authorize: async rows => rows[0]!.id === "0" ? [rows[0]!] : [] })).rejects.toMatchObject({ status: 503 });
    expect(reads).toBe(2);
  });
  it("fails with the same generic resource response after the monotonic time budget expires", async () => {
    let clock = 0;
    await expect(authorizedIssuePage({ limit: 2, offset: 0, keyset: false, maxDurationMs: 10, now: () => clock,
      read: async () => { clock = 11; return [{ id: "fixture-hidden" }]; },
      authorize: async () => [] })).rejects.toMatchObject({ status: 503, message: "Resource limit reached; retry later or narrow the query." });
  });
  it("bounds a broken candidate reader that never advances its ID cursor", async () => {
    await expect(authorizedIssuePage({ limit: 2, offset: 0, keyset: true, batchSize: 1,
      read: async () => [{ id: "unchanged" }], authorize: async () => [] })).rejects.toMatchObject({ status: 503 });
  });
});
