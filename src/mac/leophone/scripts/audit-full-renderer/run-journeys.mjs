import { auditProviderSettings } from "./provider-settings-journey.mjs";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { preview } from "vite";
import { chromium } from "playwright-core";

// Actual Web entrypoint -> Root -> real local services over HTTP/WebSocket.
// Synthetic empty HOME/workspace only. No account, provider calls or desktop IPC.
Object.assign(process.env, { ZCODE_ENV: "test", ZCODE_PRODUCT_IDENTITY: "leo" });
const output = resolve("audit-full-renderer-results");
await mkdir(output, { recursive: true });
const sandbox = await mkdtemp(resolve(output, "isolated-"));
const workspace = resolve(sandbox, "SyntheticWorkspace");
const home = resolve(sandbox, "home");
await mkdir(workspace); await mkdir(home);
await writeFile(resolve(workspace, "README.md"), "# Synthetic audit workspace\nNo real projects, accounts or family data.\n");
const env = { ...process.env, HOME: home, ZCODE_ENV: "test", ZCODE_PRODUCT_IDENTITY: "leo",
  ZCODE_DATA_BASE_DIR: home, ZCODE_SERVER_WORKSPACE: workspace,
  ZCODE_SERVER_HOST: "127.0.0.1", PORT: "3038" };
const taskSeed = execFileSync(process.execPath,
  ["--import", "tsx", "scripts/audit-full-renderer/seed-task.ts", home, workspace], { env, encoding: "utf8" });
await writeFile(resolve(output, "task-seed.log"), taskSeed);
const logs = [], errors = [], blocked = [], steps = [];
const backend = spawn(process.execPath, ["packages/server/dist/entry-http.js"],
  { env, stdio: ["ignore", "pipe", "pipe"] });
for (const stream of [backend.stdout, backend.stderr]) stream.on("data", chunk => logs.push(String(chunk)));
let server, browser, page;
const capture = async (name) => {
  await page.screenshot({ path: resolve(output, name + ".png"), fullPage: true, animations: "disabled" });
  await writeFile(resolve(output, name + ".txt"), await page.locator("body").innerText());
  await writeFile(resolve(output, name + "-aria.txt"), await page.locator("body").ariaSnapshot());
  steps.push(name);
};
try {
  let ready = false;
  for (let n = 0; n < 90; n++) {
    if (backend.exitCode !== null) throw new Error("Actual server exited " + backend.exitCode);
    try { const response = await fetch("http://127.0.0.1:3038/api/server-info"); if (response.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(ready, "Actual server must answer before browser journeys");
  // Use the built bundle: dev dependency re-optimization previously reloaded
  // the first-use transition midway and reopened Welcome without a provider.
  server = await preview({ root: resolve("packages/web"), configFile: resolve("packages/web/vite.config.ts"),
    preview: { host: "127.0.0.1", port: 5178, strictPort: true, proxy: {
      "/api/v1/oauth/token": { target: "http://127.0.0.1:3038" },
      "/api": { target: "http://127.0.0.1:3038" },
      "/ws": { target: "ws://127.0.0.1:3038", ws: true },
    } },
  });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1365, height: 960 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (["127.0.0.1", "localhost"].includes(url.hostname) || ["data:", "blob:"].includes(url.protocol)) return route.continue();
    blocked.push(url.origin + url.pathname); return route.abort();
  });
  await page.goto("http://127.0.0.1:5178/", { waitUntil: "domcontentloaded" });
  const apiEntry = page.getByRole("button", { name: "用 API Key 添加模型供应商", exact: true });
  await apiEntry.waitFor({ timeout: 90000 });
  const releaseNote = page.getByRole("button", { name: "知道了", exact: true });
  if (await releaseNote.isVisible()) {
    await capture("00-real-release-notes");
    await releaseNote.click();
  }
  const subscriptionEntry = page.getByRole("button", { name: "用订阅账号登录(ChatGPT / Copilot / OpenCode Go)", exact: true });
  const verifyActionLabel = async () => {
    const box = await subscriptionEntry.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
    assert.ok(box.content <= box.width + 1, "The first-use action label must not clip horizontally");
  };
  await verifyActionLabel();
  await capture("01-real-welcome-offline");
  await page.setViewportSize({ width: 390, height: 844 });
  await verifyActionLabel();
  await capture("01a-real-welcome-narrow-readable-labels");
  await page.setViewportSize({ width: 1365, height: 960 });
  await apiEntry.click();
  await page.getByTestId("settings-page").waitFor({ timeout: 30000 });
  await capture("02-real-settings-after-welcome");
  await page.getByTestId("model-provider-add-provider-button").click();
  await page.getByTestId("model-provider-template-item-custom").click();
  const apiKey = page.getByTestId("model-provider-api-key-input");
  await apiKey.waitFor();
  assert.equal(await apiKey.getAttribute("aria-label"), "API key");
  assert.equal(await apiKey.getAttribute("type"), "password");
  const showKey = page.getByRole("button", { name: "Show API key", exact: true });
  await showKey.focus();
  await page.keyboard.press("Enter");
  assert.equal(await apiKey.getAttribute("type"), "text");
  const hideKey = page.getByRole("button", { name: "Hide API key", exact: true });
  assert.equal(await hideKey.getAttribute("aria-pressed"), "true");
  await capture("02a-real-api-key-named-keyboard-control");
  await hideKey.click();
  assert.equal(await apiKey.getAttribute("type"), "password");
  // No key is entered and no model request is sent. Only the synthetic local
  // provider draft and actual keyboard/accessible-name semantics are exercised.
  await capture("02b-real-api-key-hidden-again");
  await auditProviderSettings({ page, output, capture });
  const navigation = page.locator('[data-testid^="settings-section-nav"]');
  const ids = await navigation.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-testid")));
  await writeFile(resolve(output,"settings-navigation.json"), JSON.stringify(ids,null,2));
  for (const [index,id] of ids.entries()) {
    const item = page.getByTestId(id);
    if (!(await item.isVisible())) continue;
    await item.click();
    await capture(`settings-${String(index).padStart(2,"0")}`);
  }
  await page.getByTestId("settings-back-button").click();
  await page.getByTestId("task-settings-button").waitFor();
  await page.getByTestId("conversation-new-task").click();
  const missingModel = page.getByTestId("chat-error-banner");
  await missingModel.getByRole("button", { name: "Model settings", exact: true }).waitFor();
  const instruction = missingModel.getByText("No model available. Sign in with a subscription or add a model provider in Settings.", { exact: true });
  assert.ok(await instruction.evaluate(element => element.scrollWidth <= element.clientWidth + 1
    && element.scrollHeight <= element.clientHeight + 1), "The missing-model recovery instruction must be fully readable");
  await capture("home-missing-model-readable-recovery");
  const failedHomeRow = page.locator('[data-leo-status-row="error"]').filter({ hasText: "Synthetic failed task" });
  await failedHomeRow.waitFor();
  assert.ok((await failedHomeRow.innerText()).includes("出错待看"));
  assert.ok(!(await failedHomeRow.innerText()).includes("做完待看"));
  const sidebarTask = page.getByTestId("task-item-audit-failed-task");
  await sidebarTask.locator('[data-error-indicator="true"]').waitFor();
  await capture("03a-real-home-and-sidebar-failed-unread");
  await failedHomeRow.click();
  await page.getByText("Synthetic preserved history", { exact: true }).waitFor({ timeout: 30000 });
  await capture("03b-real-task-open-preserved-history");
  const readTask = () => {
    const text = execFileSync(process.execPath,
      ["--import", "tsx", "scripts/audit-full-renderer/seed-task.ts", home, workspace, "--read"], { env, encoding: "utf8" });
    return JSON.parse(text.trim().split("\n").at(-1));
  };
  const observations = [];
  const readDeadline = Date.now() + 10000;
  let readback;
  do {
    readback = readTask();
    observations.push(readback);
    if (!readback.unreadAt) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < readDeadline);
  await writeFile(resolve(output, "task-after-open.json"), JSON.stringify({ observations, readback }, null, 2));
  assert.ok(!readback.unreadAt, "Opening the actual task must clear the persisted unread marker");
  assert.equal(readback.taskId, "audit-failed-task");
  assert.equal(readback.matchingCount, 1);
  assert.equal(readback.title, "Synthetic failed task");
  assert.equal(readback.status, "error", "Reading a failed task must not turn its outcome into success");
  await page.getByTestId("conversation-new-task").click();
  await page.locator('[data-leo-status-row="error"]').filter({ hasText: "Synthetic failed task" }).waitFor({ state: "hidden" });
  const afterReturn = readTask();
  assert.equal(afterReturn.taskId, readback.taskId);
  assert.equal(afterReturn.matchingCount, 1);
  assert.ok(!afterReturn.unreadAt);
  assert.equal(afterReturn.status, "error");
  await writeFile(resolve(output, "task-after-return.json"), JSON.stringify(afterReturn, null, 2));
  await capture("03c-real-home-after-reading-task");
  await page.setViewportSize({ width: 700, height: 900 });
  await capture("03-real-root-narrow-after-settings");
  await page.getByTestId("task-settings-button").click();
  await capture("04-real-settings-narrow-reopen");
  assert.deepEqual(errors, [], "Actual renderer must not raise unhandled page errors");
} catch (error) {
  errors.push(String(error));
  if (page) { try { await capture("failure"); } catch {} }
  throw error;
} finally {
  await writeFile(resolve(output,"server.log"), logs.join(""));
  await writeFile(resolve(output,"journey-results.json"), JSON.stringify({steps, errors, blocked,
    boundary: "Actual full Web renderer and local services on a synthetic workspace. Does not exercise native Electron IPC/filepickers, real provider execution or real remote machines."},null,2));
  await browser?.close(); await server?.close(); backend.kill("SIGTERM");
}
