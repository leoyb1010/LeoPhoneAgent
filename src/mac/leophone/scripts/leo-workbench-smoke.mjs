// Run after a production renderer build with VITE_ZCODE_E2E_STORE_BRIDGE=1:
// node --import tsx scripts/leo-workbench-smoke.mjs --out /absolute/proof/directory
import "./test-isolation/home.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { _electron } = require("playwright-core");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRequire = createRequire(join(repo, "packages/desktop/package.json"));
const {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
} = await import(desktopRequire.resolve("@zcode/provider"));
const { NodePersonalProviderConfigRepository, PERSONAL_PROVIDER_CONFIG_FILE_NAME } = await import(
  desktopRequire.resolve("@zcode/provider-node")
);
const outIndex = process.argv.indexOf("--out");
const out = resolve(
  outIndex >= 0 ? process.argv[outIndex + 1] : join(process.env.LEO_TEST_HOME, "proof"),
);
const testHome = process.env.LEO_TEST_HOME;
const workspace = join(testHome, "WorkbenchProject");
await mkdir(workspace, { recursive: true });
await mkdir(out, { recursive: true });
const sample = await readFile(
  join(repo, "packages/desktop/test/e2e/fixtures/leobot-workbench/report.html"),
  "utf8",
);
await writeFile(join(workspace, "report.html"), sample);
const generatedPath = join(workspace, "generated.html");
const calls = [];
let leaks = 0;
const server = createServer(async (request, response) => {
  if (request.url.startsWith("/leak")) {
    leaks++;
    response.end("blocked-preview-network-failed");
    return;
  }
  if (request.method === "GET") {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({ object: "list", data: [{ id: "workbench-fixture", object: "model" }] }),
    );
    return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  const writeTool = input.tools?.find((tool) => tool.function?.name === "Write");
  const titleRequest = !input.tools?.length;
  const hasToolResult = input.messages?.some((message) => message.role === "tool");
  const useWrite = Boolean(writeTool && !hasToolResult);
  calls.push({ path: request.url, tool: useWrite ? "Write" : "answer", stream: input.stream });
  const message = titleRequest
    ? { role: "assistant", content: "制作一份交互工作简报" }
    : useWrite
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_workbench_write",
              type: "function",
              function: {
                name: "Write",
                arguments: JSON.stringify({ file_path: generatedPath, content: sample }),
              },
            },
          ],
        }
      : {
          role: "assistant",
          content: `交互式 HTML 已完成：[generated.html](${pathToFileURL(generatedPath).href})。`,
        };
  const usage = { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42 };
  if (!input.stream) {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: "workbench-fixture",
        choices: [{ index: 0, message, finish_reason: useWrite ? "tool_calls" : "stop" }],
        usage,
      }),
    );
    return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const delta = useWrite
    ? { role: "assistant", tool_calls: [{ index: 0, ...message.tool_calls[0] }] }
    : message;
  response.write(
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "workbench-fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "workbench-fixture", choices: [{ index: 0, delta: {}, finish_reason: useWrite ? "tool_calls" : "stop" }], usage })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const repository = new NodePersonalProviderConfigRepository({
  filePath: join(testHome, ".leophoneagent", "v2", PERSONAL_PROVIDER_CONFIG_FILE_NAME),
  pollingIntervalMs: false,
});
await repository.update((current) => ({
  ...current,
  providers: current.providers.setRule({
    providerId: "workbench-fixture",
    providerName: "本地测试服务",
    config: new ProviderConfig({
      group: "standard-personal",
      access: new ApiKeyAccessConfig({ apiKey: "test-only" }),
      api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl }),
      personalModelIds: ["workbench-fixture"],
    }),
  }),
  models: current.models.setExact(
    "workbench-fixture",
    "workbench-fixture",
    new ModelConfig({
      properties: new ModelPropertiesConfig({
        requiresMfjsToolSchema: false,
        contextWindow: 200000,
        inputFormat: { supportsText: true },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
      }),
      optionSpecs: new ModelOptionSpecsConfig({ maxOutputTokens: { max: 32000 } }),
    }),
  ),
}));
repository.dispose();
const env = {
  ...process.env,
  ZCODE_DESKTOP_APPLICATION_NAME: "LeoBot Workbench Test",
  ZCODE_DESKTOP_HOME_DIR: testHome,
  ZCODE_DESKTOP_USER_DATA_DIR: join(testHome, "chromium"),
  ZCODE_DESKTOP_SESSION_DATA_DIR: join(testHome, "session"),
  ZCODE_DATA_BASE_DIR: testHome,
  ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const app = await _electron.launch({
  executablePath: require("electron"),
  args: [join(repo, "packages/desktop")],
  cwd: join(repo, "packages/desktop"),
  env,
  timeout: 60000,
});
const result = {
  scope:
    "Production Electron with deterministic model fixture; real Host/tool/file/preview/IPC. No real account/model invocation.",
  checks: [],
  screenshots: [],
  errors: [],
};
app.process().stderr.on("data", (data) => {
  void appendFile(join(out, "electron-stderr.log"), data);
});
let page;
const screenshot = async (name) => {
  // 仅让既有的菜单/布局过渡收敛；业务完成通过下方明确状态断言。
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(out, name), scale: "css" });
  result.screenshots.push(name);
};
const size = async (width, height) => {
  await app.evaluate(
    ({ BrowserWindow }, dimensions) => {
      const win = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes("/renderer/index.html"),
      );
      win.webContents.setZoomFactor(1);
      win.setContentSize(dimensions.width, dimensions.height);
    },
    { width, height },
  );
  await page.waitForFunction((width) => Math.abs(innerWidth - width) <= 2, width);
};
try {
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => result.errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error")
      void appendFile(join(out, "console-errors.log"), message.text() + "\n");
  });
  await page.getByTestId("leo-agent-select").waitFor();
  const whatsNew = page.getByRole("button", { name: "知道了", exact: true });
  if (await whatsNew.isVisible()) await whatsNew.click();
  await page.evaluate(
    (workspace) => window.__zcodeTabStoreE2E.getState().addTab(workspace),
    workspace,
  );
  await size(1440, 900);
  await page.getByTestId("leo-agent-select").click();
  await screenshot("agent-picker-1440.png");
  await page.keyboard.press("Escape");
  await page.getByTestId("leo-agent-menu").waitFor({ state: "hidden" });
  assert(
    await page.getByTestId("leo-agent-select").evaluate((node) => node === document.activeElement),
  );
  await page.keyboard.press("Enter");
  await page.getByTestId("leo-agent-menu").waitFor();
  result.checks.push("Agent picker supports Escape, focus return and keyboard reopen");
  for (const id of ["codex", "claude-code", "leobot"]) {
    const item = page.getByTestId(`leo-agent-option-${id}`);
    if (!(await item.getAttribute("data-disabled"))) {
      await item.click();
      await page.getByTestId("leo-agent-menu").waitFor({ state: "hidden" });
      await page.waitForFunction(
        (label) =>
          document.querySelector('[data-testid="leo-agent-select"]')?.textContent.includes(label),
        { codex: "Codex CLI", "claude-code": "Claude Code", leobot: "ZCode" }[id],
      );
      await page.getByTestId("leo-agent-select").click();
      result.checks.push(`Agent selection: ${id}`);
    }
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await screenshot("home-light-1440.png");
  await page.getByTestId("leo-starter-html").click();
  const input = page.getByTestId("v4-composer-input");
  await input.waitFor();
  assert((await input.innerText()).includes("真实可运行文件"));
  result.checks.push("HTML starter fills the real composer without sending");
  await size(1280, 800);
  await screenshot("home-light-1280.png");
  await page.getByTestId("v4-composer-send").click();
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(generatedPath, "utf8")) === sample) break;
    } catch {}
    for (const name of [/允许一次/, /允许本次/, /Allow once/]) {
      const approval = page.getByRole("button", { name }).first();
      if (await approval.isVisible().catch(() => false)) await approval.click();
    }
    await page.waitForTimeout(300);
  }
  assert.equal(await readFile(generatedPath, "utf8"), sample);
  result.checks.push(
    "ZCode runtime executes the fixture model's Write tool and creates a real HTML file",
  );
  await page.getByText("交互式 HTML 已完成", { exact: false }).first().waitFor({ timeout: 60000 });
  result.checks.push("Task reaches its visible completed answer");
  assert(await page.getByTestId("leo-agent-select").isDisabled());
  result.checks.push("An existing task keeps its execution Agent");
  await page.getByRole("button", { name: "generated.html", exact: true }).first().click();
  await page.getByTestId("leo-html-frame").waitFor({ timeout: 30000 });
  result.checks.push("Inline HTML file links open the same artifact preview as file cards");
  await page
    .locator('[data-zcode-stream-animate="true"]')
    .filter({ hasText: "generated.html" })
    .getByRole("button", { name: "打开", exact: true })
    .first()
    .click();
  await page.getByTestId("leo-html-frame").waitFor({ timeout: 30000 });
  await size(1440, 900);
  await page.frameLocator('[data-testid="leo-html-frame"]').locator("#toggle-details").waitFor();
  await screenshot("html-static-1440.png");
  assert.equal(await page.getByTestId("leo-html-frame").getAttribute("sandbox"), "");
  await page.getByTestId("leo-html-run").click();
  const frame = page.frameLocator('[data-testid="leo-html-frame"]');
  await frame.locator("#toggle-details").waitFor();
  await frame.locator("#toggle-details").click();
  assert.equal(await frame.locator("#report-details").isVisible(), true);
  result.checks.push("Explicit script execution works under the unchanged production parent CSP");
  await screenshot("html-interactive-1440.png");
  await page.getByTestId("leo-html-source-tab").click();
  await screenshot("html-source-1440.png");
  const savePath = join(testHome, "downloaded.html");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, savePath);
  await page.getByTestId("leo-html-download").click();
  await page.waitForTimeout(300);
  assert.equal(await readFile(savePath, "utf8"), sample);
  result.checks.push(
    "Native Save As downloads the original HTML without platform policy injection",
  );
  await input.fill("保留这条原始要求");
  await page.getByTestId("leo-html-refine").click();
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="v4-composer-input"]')
      ?.textContent.includes("generated.html"),
  );
  assert((await input.innerText()).includes("保留这条原始要求"));
  result.checks.push("Refine appends a file-specific request to the same task's real draft");
  await page.getByTestId("leo-html-preview-tab").click();
  await size(1280, 800);
  await screenshot("html-1280.png");
  await size(600, 800);
  await page.waitForTimeout(700);
  await page.getByText("HTML 文件已保存", { exact: true }).waitFor({ state: "hidden" });
  await page
    .getByText("修改要求已加入任务草稿，补充后发送", { exact: true })
    .waitFor({ state: "hidden" });
  await screenshot("html-narrow-600.png");
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  result.checks.push("Narrow layout does not create document horizontal overflow");
  // Probe navigation/fetch boundaries through the actual platform port and production renderer.
  const origin = baseUrl.replace(/\/v1$/, "");
  const guard = await page.evaluate(async (origin) => {
    const handle = await window.zcode.createHtmlPreview({
      html: `<button id="run">run</button><a id="external" href="${origin}/leak-navigation">external</a><script>fetch('${origin}/leak-fetch').catch(()=>{});document.querySelector('button').onclick=()=>document.querySelector('button').textContent='ok'</script>`,
      interactive: true,
    });
    const iframe = document.createElement("iframe");
    iframe.id = "html-policy-probe";
    iframe.sandbox = "allow-scripts";
    iframe.src = handle.url;
    iframe.style =
      "position:fixed;inset:80px 0 auto auto;width:300px;height:150px;z-index:99999;background:white";
    document.body.append(iframe);
    return handle;
  }, origin);
  const guardFrame = page.frameLocator("#html-policy-probe");
  await guardFrame.locator("#run").waitFor();
  await guardFrame.locator("#run").click();
  assert.equal(await guardFrame.locator("#run").innerText(), "ok");
  await guardFrame.locator("#external").click({ noWaitAfter: true });
  await page.waitForTimeout(300);
  assert.equal(leaks, 0);
  await page.evaluate(async (id) => {
    document.querySelector("#html-policy-probe").remove();
    await window.zcode.releaseHtmlPreview(id);
  }, guard.id);
  result.checks.push("Native preview blocks network and self-navigation");
  await size(1440, 900);
  const profile = page.getByRole("button", { name: "LeoBot", exact: true });
  // 窄屏会自动收起侧栏和产物；恢复宽度后等既有响应式布局收敛再打开。
  if (!(await profile.isVisible()))
    await page.getByRole("button", { name: "切换侧边栏", exact: true }).click();
  await page.waitForTimeout(700);
  await page
    .locator('[data-zcode-stream-animate="true"]')
    .filter({ hasText: "generated.html" })
    .getByRole("button", { name: "打开", exact: true })
    .first()
    .click();
  await page.getByTestId("leo-html-frame").waitFor();
  await page.frameLocator('[data-testid="leo-html-frame"]').locator("#toggle-details").waitFor();
  await profile.click();
  await page.getByRole("menuitem", { name: /主题模式|主题|外观/ }).hover();
  await page.getByRole("menuitemradio", { name: /深色/ }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains("theme-zai-dark"));
  await page.getByTestId("leo-html-frame").waitFor();
  await page.waitForTimeout(350);
  await screenshot("html-dark-1440.png");
  result.checks.push("Dark theme retains readable native artifact controls");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await screenshot("html-dark-reduced-motion-1440.png");
  result.checks.push("Reduced motion retains the complete artifact state");
  result.frameProcesses = await app.evaluate(({ BrowserWindow }) => {
    const owner = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes("/renderer/index.html"),
    );
    return {
      main: owner.webContents.mainFrame.processId,
      children: owner.webContents.mainFrame.frames.map((frame) => ({
        url: frame.url.slice(0, 90),
        processId: frame.processId,
      })),
    };
  });
  assert.deepEqual(result.errors, []);
  result.status = "PASS";
} catch (error) {
  result.status = "FAIL";
  result.error = error.stack;
  if (page) {
    await screenshot("FAIL.png").catch(() => {});
    await writeFile(join(out, "failure-dom.txt"), await page.locator("body").innerText());
  }
} finally {
  result.modelFixtureCalls = calls;
  result.previewNetworkLeaks = leaks;
  await writeFile(join(out, "report.json"), JSON.stringify(result, null, 2));
  await app.close();
  server.close();
}
console.log(JSON.stringify(result));
if (result.status !== "PASS") process.exitCode = 1;
