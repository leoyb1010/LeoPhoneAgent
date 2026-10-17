import assert from "node:assert/strict";
import test from "node:test";

import { parseTailscaleSelf } from "./sshTarget.js";

test("[fix-remote] M: SSH target comes from the tailnet MagicDNS name and the current user", () => {
  assert.deepEqual(parseTailscaleSelf(JSON.stringify({ Self: { DNSName: "leomac-studio.tail23de22.ts.net.", HostName: "Leo的Mac Studio" } }), "leoyuan"), {
    host: "leomac-studio",
    user: "leoyuan",
    fqdn: "leomac-studio.tail23de22.ts.net",
  });
  assert.equal(parseTailscaleSelf("{}", "leo"), null);
  assert.equal(parseTailscaleSelf("not json", "leo"), null);
  assert.equal(parseTailscaleSelf(JSON.stringify({ Self: { DNSName: "x.ts.net." } }), "bad user;rm"), null);
});
