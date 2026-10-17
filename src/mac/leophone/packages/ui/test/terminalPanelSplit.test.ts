import assert from "node:assert/strict";
import test from "node:test";

import {
  activateTerminalSession,
  closeTerminalSession,
  createTerminalSession,
  createWorkspaceTerminalState,
  exitTerminalSession,
  splitTerminalWorkspace,
  unsplitTerminalWorkspace,
  type TerminalPanelState,
} from "../src/terminal/terminalPanelState.js";

const services = {} as never;
const key = "/w/a";

function initial(): TerminalPanelState {
  const { session, workspace } = createWorkspaceTerminalState({ workspaceKey: key, services, cwd: key });
  return { sessions: { [session.id]: session }, workspaces: { [key]: workspace } };
}

function split(state: TerminalPanelState) {
  const session = createTerminalSession({ workspaceKey: key, services, cwd: key, index: 2 });
  return { state: splitTerminalWorkspace(state, key, session), right: session.id };
}

test("⌘D puts a new terminal on the right and next to the current tab; a second ⌘D does nothing", () => {
  const start = initial();
  const left = start.workspaces[key]!.activeSessionId;
  const { state, right } = split(start);
  assert.equal(state.workspaces[key]!.activeSessionId, left);
  assert.equal(state.workspaces[key]!.splitSessionId, right);
  assert.deepEqual(state.workspaces[key]!.sessionIds, [left, right]);
  assert.equal(split(state).state, state);
});

test("⌘⇧D ends the split but keeps the right terminal as a tab (its PTY stays alive)", () => {
  const { state, right } = split(initial());
  const unsplit = unsplitTerminalWorkspace(state, key);
  assert.equal(unsplit.workspaces[key]!.splitSessionId, undefined);
  assert.ok(unsplit.workspaces[key]!.sessionIds.includes(right));
  assert.ok(unsplit.sessions[right]);
  assert.equal(unsplitTerminalWorkspace(unsplit, key), unsplit);
});

test("clicking the right tab swaps sides; clicking another tab replaces the left side", () => {
  const { state, right } = split(initial());
  const left = state.workspaces[key]!.activeSessionId;
  const swapped = activateTerminalSession(state, right);
  assert.equal(swapped.workspaces[key]!.activeSessionId, right);
  assert.equal(swapped.workspaces[key]!.splitSessionId, left);
  const third = createTerminalSession({ workspaceKey: key, services, cwd: key, index: 3 });
  const withThird: TerminalPanelState = {
    sessions: { ...swapped.sessions, [third.id]: third },
    workspaces: {
      ...swapped.workspaces,
      [key]: { ...swapped.workspaces[key]!, sessionIds: [...swapped.workspaces[key]!.sessionIds, third.id] },
    },
  };
  const replaced = activateTerminalSession(withThird, third.id);
  assert.equal(replaced.workspaces[key]!.activeSessionId, third.id);
  assert.equal(replaced.workspaces[key]!.splitSessionId, left);
});

test("closing or exiting either side ends the split and the other side stays in front", () => {
  const { state, right } = split(initial());
  const left = state.workspaces[key]!.activeSessionId;
  const closedLeft = closeTerminalSession(state, left);
  assert.equal(closedLeft.workspaces[key]!.activeSessionId, right);
  assert.equal(closedLeft.workspaces[key]!.splitSessionId, undefined);
  const exitedRight = exitTerminalSession(state, right, key);
  assert.equal(exitedRight.action, "close-session");
  assert.equal(exitedRight.state.workspaces[key]!.activeSessionId, left);
  assert.equal(exitedRight.state.workspaces[key]!.splitSessionId, undefined);
});
