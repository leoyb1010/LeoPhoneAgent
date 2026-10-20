import { describe, expect, it } from "vitest";

import { createWebglPool, type WebglAddonLike } from "../src/terminal/terminalWebglPool.js";

// [leo] 终端 WebGL：离开界面释放、重挂再加载、活跃上限、contextLoss 只影响这一个。
class FakeAddon implements WebglAddonLike {
  disposed = false;
  lose: () => void = () => {};
  dispose() {
    this.disposed = true;
  }
  onContextLoss(listener: () => void) {
    this.lose = listener;
  }
}

function setup(limit = 2) {
  const addons: FakeAddon[] = [];
  const loaded: object[] = [];
  let failCreate = false;
  const pool = createWebglPool<object>({
    limit,
    create: () => {
      if (failCreate) throw new Error("no webgl");
      const addon = new FakeAddon();
      addons.push(addon);
      return addon;
    },
    load: (term) => loaded.push(term),
  });
  return { pool, addons, loaded, failCreate: () => (failCreate = true) };
}

describe("terminal WebGL pool", () => {
  it("release frees the context and a later attach loads a fresh one", () => {
    const { pool, addons } = setup();
    const term = {};
    expect(pool.attach(term)).toBe(true);
    expect(pool.attach(term)).toBe(true);
    expect(addons).toHaveLength(1);
    pool.release(term);
    expect(addons[0]!.disposed).toBe(true);
    expect(pool.activeCount()).toBe(0);
    expect(pool.attach(term)).toBe(true);
    expect(addons).toHaveLength(2);
  });

  it("caps active WebGL terminals; a slot frees up when one is disposed by xterm itself", () => {
    const { pool, addons } = setup(2);
    const [a, b, c] = [{}, {}, {}];
    pool.attach(a);
    pool.attach(b);
    expect(pool.attach(c)).toBe(false);
    // term.dispose() 走 xterm 的 AddonManager 直接调 addon.dispose()
    addons[0]!.dispose();
    expect(pool.activeCount()).toBe(1);
    expect(pool.attach(c)).toBe(true);
  });

  it("context loss drops only that terminal and allows a retry; create failure disables globally", () => {
    const { pool, addons, failCreate } = setup();
    const [a, b] = [{}, {}];
    pool.attach(a);
    pool.attach(b);
    addons[0]!.lose();
    expect(addons[0]!.disposed).toBe(true);
    expect(addons[1]!.disposed).toBe(false);
    expect(pool.attach(a)).toBe(true);
    failCreate();
    pool.release(a);
    expect(pool.attach(a)).toBe(false);
    pool.release(b);
    expect(pool.attach(b)).toBe(false);
  });
});
