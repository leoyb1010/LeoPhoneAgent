import { describe, expect, it } from "vitest";
import { authorizedIssuePage } from "../services/authorized-issue-page.js";

describe("round-two request lifetime and page budgets", () => {
  it("does not fetch a second candidate batch after cancellation during authorization", async () => {
    const controller = new AbortController();
    let reads = 0;
    const input = {
      limit: 2, offset: 0, keyset: false, batchSize: 1, signal: controller.signal,
      read: async () => [{ id: String(++reads) }],
      authorize: async (rows: { id: string }[]) => {
        if (reads === 1) controller.abort(Object.assign(new Error("aborted"), { code: "ECONNRESET" }));
        return rows;
      },
    };
    await expect(authorizedIssuePage(input)).rejects.toMatchObject({ message: "aborted", code: "ECONNRESET" });
    expect(reads).toBe(1);
  });

  it("does not return a partial result when visible offset consumes the work budget", async () => {
    let reads = 0;
    await expect(authorizedIssuePage({ limit: 3, offset: 5, keyset: false, batchSize: 2, maxCandidates: 6,
      read: async ({ offset }) => { reads++; return [{ id: String(offset) }, { id: String(offset + 1) }]; },
      authorize: async rows => rows })).rejects.toMatchObject({ status: 503 });
    expect(reads).toBe(3);
  });
});
