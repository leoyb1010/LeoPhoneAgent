import assert from "node:assert/strict";
import test from "node:test";

import { createQuickPickCommands } from "../src/quickpick/quickPickCommands.js";

const noop = () => {};
function commands(openServerWorkspace?: () => void) {
  return createQuickPickCommands({
    allowOpenWorkspace: true,
    canOpenCommunity: false,
    isSidebarVisible: true,
    isLoggedIn: false,
    themeTarget: "dark",
    shortcuts: { newTask: "", openWorkspace: "", toggleSidebar: "", toggleTerminal: "" },
    handlers: {
      createTask: noop,
      openWorkspace: noop,
      openSettings: noop,
      openSkillsSettings: noop,
      openMcpSettings: noop,
      switchTheme: noop,
      openFeedback: noop,
      openCommunity: noop,
      openProductDocs: noop,
      toggleSidebar: noop,
      toggleTerminal: noop,
      togglePreview: noop,
      openTerminalTab: noop,
      openBrowserTab: noop,
      openReviewTab: noop,
      openServerWorkspace,
    },
  });
}

test("command center offers 服务器任务 only when the host can switch to it", () => {
  let opened = 0;
  const withServer = commands(() => void opened++);
  const entry = withServer.find((command) => command.id === "open-server-tasks");
  assert.ok(entry);
  assert.equal(entry.titleId, "workspace.openServerTasks");
  assert.ok(entry.keywords.includes("服务器任务"));
  void entry.run();
  assert.equal(opened, 1);

  assert.equal(
    commands().some((command) => command.id === "open-server-tasks"),
    false,
  );
});
