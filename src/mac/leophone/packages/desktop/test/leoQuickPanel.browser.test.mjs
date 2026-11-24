import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { transform } from "esbuild";

test("late workspace refresh preserves editing and a lost receipt retries the original request", async (t) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const renderer = new URL("../src/renderer/", import.meta.url);
  const html = await readFile(new URL("leo-quick-panel.html", renderer), "utf8");
  const { code } = await transform(await readFile(new URL("leoQuickPanel.ts", renderer), "utf8"), { loader: "ts", format: "iife" });
  await page.route("http://localhost/panel", route => route.fulfill({ contentType: "text/html", body: html.replace(/<script[^>]*src="\.\/leoQuickPanel.ts"><\/script>/, "") }));
  await page.route("**/leo-tokens.css", route => route.fulfill({ body: "" }));
  await page.addInitScript(() => {
    window.requests = [];
    window.hiddenReasons = [];
    window.leoQuickPanel = {
      onState: callback => { window.pushState = callback; },
      dispatch: payload => new Promise(resolve => { window.requests.push(payload); window.ack = resolve; }),
      hide: reason => window.hiddenReasons.push(reason),
    };
  });
  await page.goto("http://localhost/panel");
  await page.addScriptTag({ content: code });
  const push = (opening, workspaces = ["/one", "/two"]) => page.evaluate(([opening, workspaces]) => window.pushState({ opening, workspaces, selected: workspaces[0], error: null }), [opening, workspaces]);
  const input = page.locator("#prompt");
  await push(true);
  assert.equal(await input.evaluate(el => document.activeElement === el), true);
  await input.fill("中文输入");
  await input.evaluate(el => el.setSelectionRange(1, 3));
  await page.waitForTimeout(800);
  await push(false);
  assert.deepEqual(await input.evaluate(el => [el.selectionStart, el.selectionEnd]), [1, 3]);
  await page.locator("#workspace").focus();
  await push(false, ["/one", "/two", "/three"]);
  assert.equal(await page.locator("#workspace").evaluate(el => document.activeElement === el), true);
  await input.focus();
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  assert.equal(await page.evaluate(() => window.requests.length), 0);
  await input.press("Enter");
  await page.evaluate(() => window.ack({ ok: false, error: "回执超时" }));
  await input.press("Enter");
  const ids = await page.evaluate(() => window.requests.map(r => r.requestId));
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  await input.fill("下一项任务");
  await page.evaluate(() => window.ack({ ok: true, taskId: "task-one" }));
  await page.waitForTimeout(650);
  assert.equal(await input.inputValue(), "下一项任务");
  assert.deepEqual(await page.evaluate(() => window.hiddenReasons), []);
  await input.press("Enter");
  assert.notEqual(await page.evaluate(() => window.requests.at(-1).requestId), ids[0]);
  await page.evaluate(() => window.ack({ ok: true, taskId: "task-two" }));
  await push(false);
  await page.waitForFunction(() => window.hiddenReasons.includes("dispatched"));
  assert.equal(await input.inputValue(), "");
});
