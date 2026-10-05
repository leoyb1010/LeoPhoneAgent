import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

// 只转译真实边界源码；Electron、窗口关闭、session.fetch 和 IPC 均使用实际实现。
const runner = String.raw`
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog } from "electron";
import { registerPaperclipIpc, registerPaperclipWindow } from "./transport.js";

app.setPath("userData", join(process.cwd(), "user-data"));
let stage = "starting";
const deadline = setTimeout(() => {
  console.error("Electron fixture timed out at " + stage);
  app.exit(2);
}, 25_000);
let authenticated = false;
let currentUserId = "fixture-human";
let attachmentRequests = 0;
let sessionRequests = 0;
let stallAttachment = false;
let attachmentStarted;
const server = createServer((request, response) => {
  if (request.url === "/auth") {
    response.setHeader("Content-Type", "text/html");
    response.setHeader("Set-Cookie", "fixture=pending; Path=/; HttpOnly");
    response.end('<button>Activate</button><script>window.onbeforeunload = (event) => { event.returnValue = false; return false; };</script>');
  } else if (request.url === "/api/auth/get-session") {
    sessionRequests += 1;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(authenticated ? { user: { id: currentUserId } } : null));
  } else if (request.url === "/api/auth/sign-out") {
    authenticated = false;
    response.setHeader("Content-Type", "application/json");
    response.end("{}");
  } else if (request.url === "/api/companies" || request.url === "/api/issues/fixture-issue/comments") {
    response.setHeader("Content-Type", "application/json");
    response.end(request.method === "GET" ? "[]" : "{}");
  } else if (request.url === "/api/attachments/fixture-artifact/content") {
    attachmentRequests += 1;
    if (stallAttachment) {
      response.write("fixture partial artifact");
      attachmentStarted();
    } else response.end("fixture artifact");
  } else {
    response.writeHead(404).end();
  }
});

void app.whenReady().then(async () => {
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = "http://127.0.0.1:" + server.address().port;
    const logs = [];
    const record = (...args) => logs.push(args.map(String).join(" "));
    registerPaperclipIpc({ logger: { info: record, warn: record, error: record } });
    const ownerPath = join(process.cwd(), "owner.html");
    const owner = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(process.cwd(), "preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    registerPaperclipWindow(owner, pathToFileURL(ownerPath).href);
    await owner.loadFile(ownerPath);
    stage = "owner loaded";
    const signOut = () => owner.webContents.executeJavaScript(
      "window.fixture.signOut(" + JSON.stringify(origin) + ")",
    );
    const startLogin = async () => {
      const created = once(app, "browser-window-created");
      const completed = owner.webContents.executeJavaScript(
        "window.fixture.signIn(" + JSON.stringify(origin) + ")",
      );
      const [, window] = await created;
      stage = "login window created";
      await once(window.webContents, "did-finish-load");
      stage = "login page loaded";
      assert.equal(await window.webContents.executeJavaScript("typeof window.onbeforeunload"), "function");
      await window.webContents.executeJavaScript("document.querySelector('button').click()", true);
      return { window, completed };
    };

    const first = await startLogin();
    const isolated = first.window.webContents.session;
    const prevented = once(first.window.webContents, "will-prevent-unload");
    stage = "control close";
    first.window.close();
    await prevented;
    assert.equal(first.window.isDestroyed(), false, "fixture must really prevent native close");
    assert.equal((await isolated.cookies.get({ url: origin })).length, 1);

    stage = "logout";
    await signOut();
    assert.deepEqual(await first.completed, { completed: false });
    assert.equal(first.window.isDestroyed(), true, "logout must destroy the beforeunload-blocked login");
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.deepEqual(await isolated.cookies.get({ url: origin }), []);

    const second = await startLogin();
    stage = "login completion";
    authenticated = true;
    assert.deepEqual(await second.completed, { completed: true });
    assert.equal(second.window.isDestroyed(), true, "successful login must also destroy the remote page");
    assert.equal(BrowserWindow.getAllWindows().length, 1);

    // 身份确认合并：5 个并发绑定读取只向服务器查询一次会话；写请求必须新鲜确认。
    stage = "identity coalescing";
    const ipcRequest = (method, path) => owner.webContents.executeJavaScript(
      "window.fixture.request(" + JSON.stringify({ serverUrl: origin, method, path, expectedUserId: "fixture-human", ...(method === "GET" ? {} : { body: {} }) }) + ")",
    );
    sessionRequests = 0;
    await Promise.all([1, 2, 3, 4, 5].map(() => ipcRequest("GET", "/api/companies")));
    assert.equal(sessionRequests, 1, "concurrent reads must share one identity query");
    await ipcRequest("POST", "/api/issues/fixture-issue/comments");
    assert.equal(sessionRequests, 2, "writes must confirm identity freshly");
    await signOut();
    assert.deepEqual(await isolated.cookies.get({ url: origin }), []);
    sessionRequests = 0;
    authenticated = true;
    await ipcRequest("GET", "/api/companies");
    assert.equal(sessionRequests, 1, "logout must invalidate the cached identity");

    // 只控制系统文件选择这一人工等待边界，其余身份、网络和保存均走真实 transport。
    const savedPath = join(process.cwd(), "artifact.txt");
    const pendingDownload = async () => {
      let announce;
      let select;
      const opened = new Promise(resolve => { announce = resolve; });
      dialog.showSaveDialog = () => {
        announce();
        return new Promise(resolve => { select = resolve; });
      };
      const completion = owner.webContents.executeJavaScript(
        "window.fixture.download(" + JSON.stringify(origin) + ")",
      );
      await opened;
      return { completion, select: () => select({ canceled: false, filePath: savedPath }) };
    };

    stage = "download dialog logout";
    authenticated = true;
    const staleDownload = await pendingDownload();
    const canceledDownload = assert.rejects(staleDownload.completion, /会话已更改|身份已改变/);
    await signOut();
    authenticated = true;
    currentUserId = "fixture-other-human";
    staleDownload.select();
    await canceledDownload;
    assert.equal(attachmentRequests, 0, "stale dialog must not issue an attachment request");
    await assert.rejects(access(savedPath), { code: "ENOENT" });

    stage = "download dialog identity change";
    currentUserId = "fixture-human";
    const changedIdentityDownload = await pendingDownload();
    const rejectedIdentity = assert.rejects(changedIdentityDownload.completion, /身份已改变/);
    currentUserId = "fixture-other-human";
    changedIdentityDownload.select();
    await rejectedIdentity;
    assert.equal(attachmentRequests, 0, "changed user must not issue an attachment request");
    await assert.rejects(access(savedPath), { code: "ENOENT" });

    stage = "valid download";
    currentUserId = "fixture-human";
    const validDownload = await pendingDownload();
    validDownload.select();
    await validDownload.completion;
    assert.equal(await readFile(savedPath, "utf8"), "fixture artifact");
    assert.equal(attachmentRequests, 1);
    await rm(savedPath);

    stage = "download body logout";
    stallAttachment = true;
    const bodyStarted = new Promise(resolve => { attachmentStarted = resolve; });
    const interruptedDownload = await pendingDownload();
    const interrupted = assert.rejects(interruptedDownload.completion, /abort|会话|cancel/i);
    interruptedDownload.select();
    await bodyStarted;
    await signOut();
    await interrupted;
    await assert.rejects(access(savedPath), { code: "ENOENT" });
    // 日志可追溯生命周期，但不能出现服务器地址或 Cookie 值。
    assert.ok(logs.some((line) => line.includes("登录窗口已创建")));
    assert.ok(logs.some((line) => line.includes("开始注销")));
    assert.ok(logs.every((line) => !line.includes(origin) && !line.includes("pending")));
    process.stdout.write("real Electron beforeunload, logout, cookies, login reentry and download isolation passed\n");
    clearTimeout(deadline);
    server.closeAllConnections();
    server.close();
    owner.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    server.closeAllConnections();
    server.close();
    app.exit(1);
  }
});
`;

test(
  "real Electron isolates login termination and downloads across logout or account changes",
  { skip: process.platform !== "darwin", timeout: 45_000 },
  async () => {
    const folder = await mkdtemp(join(tmpdir(), "paperclip-electron-regression-"));
    try {
      for (const name of ["transport", "policy", "sessionScope", "channels", "paperclipProtocol"]) {
        const sourceUrl = new URL(
          ["channels", "paperclipProtocol"].includes(name)
            ? `../../../../shared/src/${name}.ts`
            : `./${name}.ts`,
          import.meta.url,
        );
        const source = await readFile(sourceUrl, "utf8");
        const output = ts
          .transpileModule(source, {
            fileName: fileURLToPath(sourceUrl),
            compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
          })
          .outputText.replace(/from ["']@zcode\/shared["']/g, 'from "./shared.js"');
        await writeFile(join(folder, `${name}.js`), output);
      }
      // 只暴露边界源码实际使用的共享模块（IPC channel 与无依赖的协议规则），不加载整个 shared 包。
      await writeFile(
        join(folder, "shared.js"),
        'export * from "./channels.js";\nexport * from "./paperclipProtocol.js";\n',
      );
      await writeFile(join(folder, "package.json"), '{"type":"module"}');
      await writeFile(
        join(folder, "owner.html"),
        "<!doctype html><title>Paperclip IPC fixture</title>",
      );
      await writeFile(
        join(folder, "preload.cjs"),
        `const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("fixture", {
  signIn: serverUrl => ipcRenderer.invoke("leo:paperclip:sign-in", { serverUrl }),
  signOut: serverUrl => ipcRenderer.invoke("leo:paperclip:sign-out", { serverUrl }),
  request: input => ipcRenderer.invoke("leo:paperclip:request", input),
  download: serverUrl => ipcRenderer.invoke("leo:paperclip:download", {
    serverUrl, path: "/api/attachments/fixture-artifact/content",
    filename: "artifact.txt", expectedUserId: "fixture-human",
  }),
});`,
      );
      await writeFile(join(folder, "runner.mjs"), runner);
      const electronPath: string = createRequire(import.meta.url)("electron");
      const env = { ...process.env };
      delete env["ELECTRON_RUN_AS_NODE"];
      const result = await new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          const child = spawn(electronPath, [join(folder, "runner.mjs")], {
            cwd: folder,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
          const deadline = setTimeout(() => child.kill("SIGKILL"), 35_000);
          child.once("error", (error) => {
            clearTimeout(deadline);
            reject(error);
          });
          child.once("close", (code) => {
            clearTimeout(deadline);
            resolve({ code, output });
          });
        },
      );
      assert.equal(result.code, 0, result.output);
      assert.match(
        result.output,
        /real Electron beforeunload, logout, cookies, login reentry and download isolation passed/,
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
);
