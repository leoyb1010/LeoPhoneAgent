import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const { createServer } = await import(process.env.PAPERCLIP_VITE_PATH || "vite");
const { default: tailwind } = await import(
  process.env.PAPERCLIP_TAILWIND_PATH || "@tailwindcss/vite"
);
import { chromium } from "playwright-core";
const root = fileURLToPath(new URL(".", import.meta.url));
const server = await createServer({
  configFile: false,
  root,
  plugins: [tailwind()],
  server: {
    host: "127.0.0.1",
    port: 4317,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
  },
});
await server.listen();
if (process.env.PAPERCLIP_SERVE_ONLY === "1") {
  console.log("Paperclip UI harness: http://127.0.0.1:4317");
  await new Promise(() => {});
}
const executablePath =
  process.env.CHROMIUM_PATH ||
  (process.platform === "linux" && existsSync("/usr/bin/chromium")
    ? "/usr/bin/chromium"
    : undefined);
const output =
  process.env.PAPERCLIP_UI_OUTPUT ||
  fileURLToPath(new URL("../../paperclip-ui-results", import.meta.url));
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto("http://127.0.0.1:4317");
  await page.getByLabel("服务器地址", { exact: true }).fill("https://server.example");
  await page.getByRole("button", { name: "保存并连接", exact: true }).click();
  await page.getByRole("button", { name: "登录服务器", exact: true }).click();
  await page.getByLabel("工作组织", { exact: true }).selectOption("company-1");
  await page.getByRole("button", { name: /验证原生任务工作区/ }).click();
  await page.getByLabel("回复任务", { exact: true }).fill("请给出中文结果");
  await page.getByRole("button", { name: "发送回复", exact: true }).click();
  await page.getByText("请给出中文结果", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.paperclipHarness.posts), 1);
  await page.getByRole("tab", { name: "运行与日志", exact: true }).click();
  await page.getByRole("button", { name: "读取日志", exact: true }).click();
  await page.getByText("服务器已开始处理任务", { exact: true }).waitFor();
  await page.getByRole("button", { name: "取消运行", exact: true }).click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await page.evaluate(() => window.paperclipHarness.posts), 1);
  await page.getByRole("tab", { name: /审批/ }).click();
  await page.getByRole("button", { name: "批准请求", exact: true }).click();
  await page.getByLabel("审批处理说明").fill("已核对权限范围");
  await page.getByRole("button", { name: "确认提交", exact: true }).click();
  await page.getByText("新增智能体 · 已批准", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "成果与附件", exact: true }).click();
  await page.getByRole("button", { name: "阅读文档", exact: true }).click();
  await page.getByText("这是服务器上的中文文档正文", { exact: true }).waitFor();
  await page.getByRole("button", { name: "下载附件", exact: true }).click();
  await page.waitForFunction(() => document.body.dataset.downloaded === "true");
  await page.getByRole("tab", { name: "对话", exact: true }).click();
  await page.getByLabel("回复任务", { exact: true }).fill("断网后核实原操作");
  await page.evaluate(() => window.paperclipHarness.loseNextReceipt());
  await page.getByRole("button", { name: "发送回复", exact: true }).click();
  await page.getByRole("button", { name: "核实结果", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "发送回复", exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "核实结果", exact: true }).click();
  await page.getByText("断网后核实原操作", { exact: true }).waitFor();
  await page.getByRole("button", { name: "本地恢复模式", exact: true }).click();
  await page.getByRole("button", { name: "留在服务器工作区", exact: true }).click();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("button", { name: "本地恢复模式", exact: true }).click();
  await page.getByRole("button", { name: "进入本地恢复模式", exact: true }).click();
  assert.equal(await page.evaluate(() => document.body.dataset.recovery), "true");
  await page.getByRole("button", { name: "留在服务器工作区", exact: true }).click();
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: join(output, "workspace.png"), fullPage: true });
  await page.setViewportSize({ width: 700, height: 1000 });
  await page.screenshot({
    path: join(output, "workspace-narrow.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "journeys.json"),
    JSON.stringify(
      {
        status: "passed",
        authenticatedServer: "injected-contract-fixture",
        realServerLoginTested: false,
        journeys: [
          "配置服务器",
          "登录个人账号",
          "选择组织",
          "回复任务",
          "查看运行日志",
          "取消运行后返回",
          "批准请求",
          "阅读文档",
          "下载附件",
          "恢复未知操作回执",
          "显式本地恢复模式",
          "窄屏布局",
        ],
        consoleErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "Paperclip UI smoke PASS: 配置、登录、组织、回复、日志、取消返回、审批、文档、下载、未知回执核实、恢复模式与窄屏",
  );
} catch (error) {
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  await writeFile(join(output, "failure.json"), JSON.stringify({
    error: String(error), consoleErrors: errors,
    url: page.url(),
    body: await page.locator("body").innerText().catch(() => "页面不可读取"),
  }, null, 2));
  throw error;
} finally {
  await browser.close();
  await server.close();
}
