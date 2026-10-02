import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const output = resolve("audit-phone-link-results");
await mkdir(output, { recursive: true });
const server = await createServer({
  configFile: resolve("scripts/audit-phone-link/vite.config.ts"),
  server: { host: "127.0.0.1", port: 5177, strictPort: true },
});
await server.listen();
let browser;
const steps = [],
  pageErrors = [];
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 960, height: 900 } });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // The fixture must never call an external account, relay, telemetry or provider.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) || url.protocol === "data:"
      ? route.continue()
      : route.abort();
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const screenshot = async (name, detail) => {
    await page.screenshot({ path: resolve(output, name + ".png"), fullPage: true });
    steps.push({ name, detail });
  };
  const waitText = (text) => page.getByText(text, { exact: true }).waitFor();
  await page.goto("http://127.0.0.1:5177/");
  await waitText("Synthetic Mac 已连上中继 · 中继 0.2");
  await screenshot(
    "01-ready",
    "Actual phone-link component and production styles; synthetic connected bridge",
  );
  await button("扫码连接手机").click();
  await waitText("待发 1 · 已签发 0 · 未撤销 0 · 已撤销 0");
  assert.equal(await button("扫码连接手机").isDisabled(), true);
  await button("关闭面板").click();
  await button("完成待发配对请求").click();
  await waitText("待发 0 · 已签发 1 · 未撤销 0 · 已撤销 1");
  await screenshot(
    "02-close-before-reply",
    "Late code revoked after panel close; no active synthetic credential",
  );
  await button("打开面板").click();
  await button("扫码连接手机").click();
  await button("完成待发配对请求").click();
  await page.getByRole("img", { name: "配对二维码" }).waitFor();
  await screenshot(
    "03-code-visible",
    "Reopen and generate renders an actual QR for an unusable synthetic payload",
  );
  await button("撤销错误：关").click();
  await button("换一个码").click();
  await page.getByRole("alert").waitFor();
  assert.equal(await page.getByRole("img", { name: "配对二维码" }).count(), 0);
  await waitText("待发 0 · 已签发 2 · 未撤销 1 · 已撤销 1");
  await screenshot(
    "04-revoke-failure",
    "Replacement blocked; old image hidden; error states original code may remain valid",
  );
  await button("撤销错误：开").click();
  await button("扫码连接手机").click();
  await button("完成待发配对请求").click();
  await page.getByRole("img", { name: "配对二维码" }).waitFor();
  await waitText("待发 0 · 已签发 3 · 未撤销 1 · 已撤销 2");
  await button("关闭面板").click();
  await waitText("待发 0 · 已签发 3 · 未撤销 0 · 已撤销 3");
  await button("打开面板").click();
  await button("状态错误：关").click();
  await waitText("读不到连接状态(连接状态读取失败，正在重试)");
  assert.equal(await button("扫码连接手机").isDisabled(), true);
  await screenshot(
    "05-status-failure",
    "Rejected IPC is visible and does not escape as an unhandled page error",
  );
  await button("状态错误：开").click();
  await waitText("Synthetic Mac 已连上中继 · 中继 0.2");
  await page.getByText("Tailscale 直连与已授权设备", { exact: true }).click();
  await page.getByLabel("Tailscale HTTPS 地址", { exact: true }).fill("https://invalid.example");
  await button("保存并启用").click();
  await waitText("Invalid synthetic direct configuration");
  await page
    .getByLabel("Tailscale HTTPS 地址", { exact: true })
    .fill("https://fixture.synthetic.ts.net");
  await page.getByLabel("直连本机端口", { exact: true }).fill("38475");
  await button("保存并启用").click();
  await waitText("已保存，15 秒内应用。HTTPS 转发须在 Tailscale 中完成配置。");
  const config = await page.evaluate(() => JSON.parse(localStorage.getItem("leo-audit-direct")));
  assert.equal(config.port, 38475);
  assert.equal(config.baseURL, "https://fixture.synthetic.ts.net");
  await screenshot(
    "06-direct-form",
    "Invalid field recovery and save-to-fixture-storage closure; native host persistence tested separately",
  );
  await button("切换深浅主题").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(
    "07-dark-narrow",
    "Production component at narrow browser viewport, not an iOS native runtime",
  );
  assert.deepEqual(pageErrors, []);
  await writeFile(
    resolve(output, "journeys.json"),
    JSON.stringify(
      {
        status: "passed",
        steps,
        pageErrors,
        limits: [
          "Synthetic bridge, no Electron IPC or real device",
          "No real credentials, cloud accounts, production or native app runtime",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
