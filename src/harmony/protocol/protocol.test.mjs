import assert from "node:assert/strict";
import {
  parseMachines,
  harnessURL,
  sameApiRoot,
  apiRootFromHarnessURL,
  isAndroidBody,
  isHarmonyBody,
} from "./relayMachines.ts";
import { encodePair, decodePair } from "./relayPair.ts";
import { agentWsUrl, registerFrame, parseSseData } from "./relayOutbound.ts";
import { capabilitiesFromJson, sessionSummaryFromJson } from "./harnessTypes.ts";

const ROOT = "https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api";

{
  const rows = parseMachines({
    machines: [
      { name: "LeodeMac-mini-2", online: true, server: "leocodebox" },
      { name: "LeoFold8", online: true, platform: "android", server: "minis", version: "1.0.0-alpha.6" },
      { name: "LeoMate", online: true, platform: "harmony", server: "minis", version: "0.1.0-alpha.1" },
      { name: "" },
    ],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[1].platform, "android");
  assert.equal(rows[2].platform, "harmony");
  assert.equal(isAndroidBody(rows[1]), true);
  assert.equal(isAndroidBody(rows[2]), false);
  assert.equal(isHarmonyBody(rows[2]), true);
  assert.equal(harnessURL(ROOT + "/", "LeoFold8"), ROOT + "/m/LeoFold8");
  assert.equal(sameApiRoot(ROOT + "/", ROOT), true);
  assert.equal(apiRootFromHarnessURL(ROOT + "/m/LeoFold8"), ROOT);
}

{
  const code = encodePair(ROOT + "/", "LeoMate");
  assert.ok(code.startsWith("leoagent-body:v1|"));
  assert.deepEqual(decodePair(code), { apiRoot: ROOT, machine: "LeoMate" });
  assert.equal(decodePair("not-a-code"), null);
  assert.equal(decodePair('leoagent-body:v1|{"apiRoot":"http://insecure","machine":"x"}'), null);
  assert.equal(decodePair(`leoagent-body:v1|{"apiRoot":"${ROOT}","machine":"a/b"}`), null);
  assert.ok(!code.includes("key"));
  const evil = decodePair(`leoagent-body:v1|{"apiRoot":"https://evil.example/relay/api","machine":"LeoMate"}`);
  assert.equal(evil && evil.apiRoot, "https://evil.example/relay/api");
}

{
  assert.equal(
    agentWsUrl(ROOT),
    "wss://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/agent",
  );
  const frame = registerFrame("LeoMate", "k".repeat(16), "0.1.0-alpha.1");
  assert.equal(frame.type, "register");
  assert.equal(frame.info.platform, "harmony");
  assert.equal(frame.info.server, "minis");
  assert.equal(parseSseData('data: {"seq":1}'), '{"seq":1}');
  assert.equal(parseSseData("keep-alive"), null);
}

{
  const kinds = capabilitiesFromJson({
    harnesses: [{ key: "minis", name: "LeoPhoneAgent" }, { name: "no-key" }],
  });
  assert.equal(kinds.length, 1);
  assert.equal(kinds[0].key, "minis");
  const summary = sessionSummaryFromJson({
    session_id: "hs_1",
    harness: "minis",
    name: "LeoPhoneAgent",
    cwd: "~",
    status: "running",
    seq: 3,
    waiting_for_approval: true,
    pending_approvals: [{ approval_id: "ap_1", command: "ls" }],
  });
  assert.equal(summary && summary.id, "hs_1");
  assert.equal(summary && summary.pendingApprovalId, "ap_1");
}

console.log("PROTOCOL_MACHINES_OK");
