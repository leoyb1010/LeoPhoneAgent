import assert from "node:assert/strict";
import { test } from "node:test";

import { createSingleFeatureRollout } from "./singleFeatureRollout.js";

test("a failed config request is not retried on every refresh", async () => {
  let requests = 0;
  const rollout = createSingleFeatureRollout<{ enabled: boolean }>({
    resolveConfig: () => ({ enabled: true }),
    defaultValue: { enabled: false },
    logTag: "t",
    fetchConfig: async () => {
      requests++;
      throw new Error("unreachable");
    },
    logger: { warn() {} },
  });
  for (let i = 0; i < 5; i++) assert.deepEqual(await rollout.refresh(), { enabled: false });
  assert.equal(requests, 1);
});
