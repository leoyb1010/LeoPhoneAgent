import { auditProviderSettings } from "./provider-settings-journey.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { _electron as electron } from "playwright-core";

// Real unpackaged Desktop main -> Local Host -> WindowController -> renderer.
// Isolated hosted macOS only. No credentials, remote machine, prompt or installer.
assert.equal(process.platform, "darwin", "Native Desktop capture requires the hosted macOS runner");
assert.equal(process.env.GITHUB_ACTIONS, "true", "This capture must not run on a user's desktop");
const output = resolve("audit-full-renderer-results/desktop");
await mkdir(output, { recursive: true });
const sandbox = await mkdtemp(resolve("audit-full-renderer-results/isolated-desktop-"));
const home = resolve(sandbox, "home"), workspace = resolve(sandbox, "SyntheticWorkspace");
const userData = resolve(sandbox, "user-data"), sessionData = resolve(sandbox, "session-data");
for (const directory of [home, workspace, userData, sessionData]) await mkdir(directory);
await writeFile(resolve(workspace, "README.md"), "# Synthetic desktop audit\nNo real accounts or data.\n");
const env = { ...process.env, HOME: home, ZCODE_HOME: home, LEOAGENT_HOME: home,
  ZCODE_DATA_BASE_DIR: home, ZCODE_ENV: "test", ZCODE_PRODUCT_IDENTITY: "leo",
  ZCODE_DESKTOP_APPLICATION_NAME: "LeoPhoneAgent Synthetic Audit",
  ZCODE_DESKTOP_HOME_DIR: home, ZCODE_DESKTOP_USER_DATA_DIR: userData,
  ZCODE_DESKTOP_SESSION_DATA_DIR: sessionData,
  ZCODE_E2E_RUN_ID: "synthetic-desktop-audit", ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1" };
delete env.ZCODE_AUTO_UPDATE_DEV;
delete env.ELECTRON_RENDERER_URL;
delete env.ELECTRON_RUN_AS_NODE;
const seeded = execFileSync(process.execPath,
  ["--import", "tsx", "scripts/audit-full-renderer/seed-task.ts", home, workspace, "--desktop"],
  { env, encoding: "utf8", timeout: 15000 });
await writeFile(resolve(output, "task-seed.log"), seeded);
const requireDesktop = createRequire(resolve("packages/desktop/package.json"));
const executablePath = requireDesktop("electron");
const errors = [], consoleErrors = [], blockedRequests = [], steps = [];
let app, page;
const capture = async (name) => {
  await page.screenshot({ path: resolve(output, name + ".png"), fullPage: true, animations: "disabled" });
  await writeFile(resolve(output, name + ".txt"), await page.locator("body").innerText());
  await writeFile(resolve(output, name + "-aria.txt"), await page.locator("body").ariaSnapshot());
  steps.push(name);
};
const readTask = () => JSON.parse(execFileSync(process.execPath,
  ["--import", "tsx", "scripts/audit-full-renderer/seed-task.ts", home, workspace, "--read"],
  { env, encoding: "utf8", timeout: 3000 }).trim().split("\n").at(-1));
try {
  app = await electron.launch({ executablePath, args: [resolve("packages/desktop")],
    env, chromiumSandbox: true, timeout: 60000 });
  app.process().stdout?.on("data", chunk => consoleErrors.push(String(chunk)));
  app.process().stderr?.on("data", chunk => consoleErrors.push(String(chunk)));
  const runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged,
    name: app.getName(), home: app.getPath("home"), userData: app.getPath("userData"),
    sessionData: app.getPath("sessionData"), arguments: process.argv }));
  await writeFile(resolve(output, "runtime-isolation.json"), JSON.stringify(runtime, null, 2));
  assert.equal(runtime.packaged, false);
  assert.equal(runtime.home, home); assert.equal(runtime.userData, userData);
  assert.equal(runtime.sessionData, sessionData);
  assert.ok(!runtime.arguments.includes("--no-sandbox"));
  assert.ok(!runtime.arguments.includes("--zcode-auto-update-dev"));
  await app.context().route("**/*", route => {
    const url = new URL(route.request().url());
    if (["file:", "data:", "blob:"].includes(url.protocol)
      || ["127.0.0.1", "localhost"].includes(url.hostname)) return route.continue();
    blockedRequests.push(url.origin + url.pathname); return route.abort();
  });
  page = await app.firstWindow({ timeout: 60000 });
  page.on("pageerror", error => errors.push(error.message));
  const welcome = page.getByRole("button", { name: "用 API Key 添加模型供应商", exact: true });
  await welcome.waitFor({ timeout: 90000 });
  const releaseNotes = page.getByRole("button", { name: "知道了", exact: true });
  if (await releaseNotes.isVisible()) await releaseNotes.click();
  await capture("01-native-desktop-first-use");
  await welcome.click();
  await page.getByTestId("model-provider-add-provider-button").click();
  await page.getByTestId("model-provider-template-item-custom").click();
  const key = page.getByTestId("model-provider-api-key-input");
  await key.waitFor(); assert.equal(await key.getAttribute("aria-label"), "API key");
  await page.getByRole("button", { name: "Show API key", exact: true }).focus();
  await page.keyboard.press("Enter"); assert.equal(await key.getAttribute("type"), "text");
  await page.getByRole("button", { name: "Hide API key", exact: true }).click();
  assert.equal(await key.getAttribute("type"), "password");
  await capture("02-native-desktop-api-key-controls");
  await auditProviderSettings({ page, output, capture });
  await page.getByTestId("settings-back-button").click();
  await page.getByTestId("conversation-new-task").click();
  const missingModel = page.getByTestId("chat-error-banner");
  await missingModel.getByRole("button", { name: "Model settings", exact: true }).waitFor();
  const instruction = missingModel.getByText("No model available. Sign in with a subscription or add a model provider in Settings.", { exact: true });
  assert.ok(await instruction.evaluate(element => element.scrollWidth <= element.clientWidth + 1
    && element.scrollHeight <= element.clientHeight + 1), "The missing-model recovery instruction must be fully readable");
  await capture("home-missing-model-readable-recovery");
  const failed = page.locator('[data-leo-status-row="error"]').filter({ hasText: "Synthetic failed task" });
  await failed.waitFor({ timeout: 30000 });
  assert.ok((await failed.innerText()).includes("出错待看"));
  assert.ok(!(await failed.innerText()).includes("做完待看"));
  await page.getByTestId("task-item-audit-failed-task").locator('[data-error-indicator="true"]').waitFor();
  await capture("03-native-home-and-sidebar-failed-unread");
  await failed.click();
  await page.getByText("Synthetic preserved history", { exact: true }).waitFor({ timeout: 30000 });
  await capture("04-native-open-task-history");
  const observations = [], deadline = Date.now() + 10000;
  let state;
  do {
    state = readTask(); observations.push(state);
    if (!state.unreadAt) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  await writeFile(resolve(output, "task-readback.json"), JSON.stringify({ observations, state }, null, 2));
  assert.ok(!state.unreadAt); assert.equal(state.status, "error");
  assert.equal(state.matchingCount, 1); assert.equal(state.title, "Synthetic failed task");
  assert.equal(state.cliSessionId, "audit-failed-task"); assert.equal(state.cliMessageCount, 2);
  assert.ok(state.cliHistory.includes("Synthetic preserved history"));
  await page.getByTestId("conversation-new-task").click();
  await failed.waitFor({ state: "hidden" });
  const afterReturn = readTask();
  assert.equal(afterReturn.status, "error"); assert.equal(afterReturn.matchingCount, 1);
  assert.ok(!afterReturn.unreadAt);
  await writeFile(resolve(output, "task-after-return.json"), JSON.stringify(afterReturn, null, 2));
  await capture("05-native-home-after-reading-failed-task");
  assert.deepEqual(errors, []);
} catch (error) {
  errors.push(String(error));
  if (page) { try { await capture("failure"); } catch {} }
  throw error;
} finally {
  await writeFile(resolve(output, "desktop-process.log"), consoleErrors.join(""));
  await writeFile(resolve(output, "results.json"), JSON.stringify({ steps, errors, blockedRequests,
    boundary: "Actual unpackaged Electron desktop on isolated hosted macOS; synthetic persisted task and empty provider, no real credentials/provider execution or physical device." }, null, 2));
  await app?.close();
}
