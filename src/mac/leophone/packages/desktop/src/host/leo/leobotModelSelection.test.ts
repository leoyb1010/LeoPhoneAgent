import assert from "node:assert/strict";
import test from "node:test";

import { resolveLeoBotModelSelection } from "./leobotModelSelection.js";

type View = Awaited<ReturnType<Parameters<typeof resolveLeoBotModelSelection>[0]["getView"]>>;
const model = (modelId: string, values: string[]) => ({ modelId, config: { optionSpecs: { reasoningLevel: { values } } } });
const service = (view: Partial<View>) => ({ getView: async () => ({ revision: 1, providers: [], ...view }) as unknown as View });

test("[fix-remote] LeoBot uses the Mac's default model when it is not an external agent", async () => {
  const preferred = { providerId: "p", modelId: "m", options: { reasoningLevel: "high" } };
  assert.deepEqual(await resolveLeoBotModelSelection(service({ preferredSelection: preferred })), preferred);
});

test("[fix-remote] LeoBot never falls back to acp; first non-acp model otherwise, null when there is none", async () => {
  const acp = { providerId: "acp", models: [model("claude-code", ["default"])] };
  const personal = { providerId: "personal", models: [model("glm", ["low", "high"])] };
  assert.deepEqual(
    await resolveLeoBotModelSelection(
      service({
        preferredSelection: { providerId: "acp", modelId: "claude-code" },
        providers: [acp, personal] as unknown as View["providers"],
      }),
    ),
    { providerId: "personal", modelId: "glm", options: { reasoningLevel: "high" } },
  );
  assert.equal(
    await resolveLeoBotModelSelection(service({ providers: [acp] as unknown as View["providers"] })),
    null,
  );
});
