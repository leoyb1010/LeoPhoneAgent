import assert from "node:assert/strict";
import test from "node:test";
import { createTaskListLoadCoordinator } from "../src/hooks/taskListLoadCoordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const owner = createTaskListLoadCoordinator();
  const state = { items: ["existing"], loading: false, error: null as string | null };
  const run = (load: () => Promise<string[]>) => owner.run({ load,
    onLoading: value => { state.loading = value; if (value) state.error = null; },
    onResult: value => { state.items = value; },
    onError: error => { state.error = String(error); },
  });
  return { owner, state, run };
}
test("failure keeps last tasks; retry clears error and replaces only on successful reply", async () => {
  const { state, run } = fixture();
  await run(async () => { throw new Error("offline"); });
  assert.deepEqual(state, { items: ["existing"], loading: false, error: "Error: offline" });
  const retry = deferred<string[]>(); const pending = run(() => retry.promise);
  assert.deepEqual(state, { items: ["existing"], loading: true, error: null });
  retry.resolve(["recovered"]); await pending;
  assert.deepEqual(state, { items: ["recovered"], loading: false, error: null });
});
test("late old success cannot replace a newer pending or successful query", async () => {
  const { state, run } = fixture(); const old = deferred<string[]>(), current = deferred<string[]>();
  const first = run(() => old.promise), second = run(() => current.promise);
  old.resolve(["wrong workspace"]); await first;
  assert.deepEqual(state, { items: ["existing"], loading: true, error: null });
  current.resolve(["current"]); await second;
  assert.deepEqual(state.items, ["current"]); assert.equal(state.loading, false);
});
test("late old error does not clear loading or report failure on a new request", async () => {
  const { state, run } = fixture(); const old = deferred<string[]>(), current = deferred<string[]>();
  const first = run(() => old.promise), second = run(() => current.promise);
  old.reject(new Error("old")); await first;
  assert.deepEqual(state, { items: ["existing"], loading: true, error: null });
  current.resolve(["current"]); await second;
  assert.equal(state.error, null);
});
test("dispose ignores both success and failure even when underlying requests continue", async () => {
  for (const fails of [false, true]) {
    const { owner, state, run } = fixture(); const request = deferred<string[]>();
    const pending = run(() => request.promise); owner.dispose();
    const snapshot = structuredClone(state);
    if (fails) request.reject(new Error("late")); else request.resolve(["late"]);
    await pending; assert.deepEqual(state, snapshot);
    let calls = 0; await run(async () => { calls += 1; return []; });
    assert.equal(calls, 0);
  }
});
test("effect reactivation gives a new query ownership without reviving an old reply", async () => {
  const { owner, state, run } = fixture(); const old = deferred<string[]>();
  const pending = run(() => old.promise); owner.dispose(); owner.activate();
  await run(async () => ["new mount"]); old.resolve(["retired"]); await pending;
  assert.deepEqual(state, { items: ["new mount"], loading: false, error: null });
});
test("empty scope invalidation retires the prior request without changing current display", async () => {
  const { owner, state, run } = fixture(); const old = deferred<string[]>();
  const pending = run(() => old.promise); owner.invalidate();
  state.items = []; state.loading = false;
  old.resolve(["old scope"]); await pending;
  assert.deepEqual(state, { items: [], loading: false, error: null });
});
