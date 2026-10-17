import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePeekabooPermissions } from "./computerUseCore.js";

// 本机 peekaboo 4.9.4 `permissions status --json` 的真实输出(debug_logs 略)。
const REAL = JSON.stringify({
  data: {
    permissions: [
      {
        grantInstructions: "System Settings > Privacy & Security > Screen & System Audio Recording",
        isRequired: true,
        isGranted: true,
        name: "Screen Recording",
      },
      {
        grantInstructions: "System Settings > Privacy & Security > Device Control and Data Access",
        isRequired: true,
        isGranted: false,
        name: "Accessibility",
      },
      {
        grantInstructions: "System Settings > Privacy & Security > Device Control and Data Access",
        isRequired: false,
        isGranted: false,
        name: "Event Synthesizing",
      },
    ],
    source: "bridge",
  },
  success: true,
});

test("maps the three permissions with required / granted / instructions", () => {
  const status = parsePeekabooPermissions(REAL);
  assert.equal(status.state, "ok");
  if (status.state !== "ok") return;
  assert.deepEqual(
    status.permissions.map((p) => [p.key, p.required, p.granted]),
    [
      ["screen-recording", true, true],
      ["accessibility", true, false],
      ["event-synthesizing", false, false],
    ],
  );
  assert.equal(status.source, "bridge");
  assert.match(status.permissions[0]!.instructions, /Screen & System Audio Recording/);
});

test("non-JSON or unsuccessful output becomes an error the UI can show", () => {
  assert.deepEqual(parsePeekabooPermissions("boom"), {
    state: "error",
    message: "Peekaboo 返回的不是 JSON",
  });
  assert.deepEqual(
    parsePeekabooPermissions(JSON.stringify({ success: false, error: { message: "no bridge" } })),
    {
      state: "error",
      message: "no bridge",
    },
  );
});
