/**
 * [leo] 订阅账号登录页。由本机接口直接提供(http://127.0.0.1:38473/leo/oauth),
 * 在系统浏览器里打开 —— 反正授权流程本来就要跳浏览器。
 *
 * 页面的接口调用都带 `X-Leo-UI: 1`:浏览器跨站请求带不了自定义头(会先发预检,
 * 我们不回 CORS 放行),所以别的网站没法冒充这个页面去发起登录或退出。
 * 凭据从不经过这个页面,它只能看到「哪家登了、有几个模型」。
 */
export const OAUTH_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LeoPhoneAgent · 订阅账号登录</title>
<style>
  :root { color-scheme: light dark; --fg:#1d1d1f; --sub:#6e6e73; --line:rgba(0,0,0,.1); --bg:#fbfbfd; --card:#fff; --ok:#1a7f37; --accent:#0a66ff; }
  @media (prefers-color-scheme: dark) { :root { --fg:#f5f5f7; --sub:#98989d; --line:rgba(255,255,255,.12); --bg:#111113; --card:#1c1c1e; --ok:#3fb950; --accent:#4c8dff; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.55 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width:640px; margin:0 auto; padding:40px 20px 60px; }
  h1 { font-size:20px; margin:0 0 4px; font-weight:600; }
  p.lead { color:var(--sub); margin:0 0 24px; }
  .row { display:flex; align-items:center; gap:12px; padding:14px 16px; background:var(--card); border:1px solid var(--line); border-radius:10px; margin-bottom:8px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--line); flex:none; }
  .dot.on { background:var(--ok); }
  .name { flex:1; min-width:0; }
  .name b { font-weight:600; }
  .name small { display:block; color:var(--sub); }
  button { font:inherit; border:1px solid var(--line); background:transparent; color:var(--fg); padding:6px 14px; border-radius:8px; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button:disabled { opacity:.5; cursor:default; }
  .flow { margin-top:20px; padding:16px; border:1px solid var(--line); border-radius:10px; background:var(--card); }
  .flow h2 { font-size:15px; margin:0 0 8px; }
  .flow a { color:var(--accent); word-break:break-all; }
  .code { font:600 22px ui-monospace, Menlo, monospace; letter-spacing:2px; margin:6px 0; }
  .flow input { width:100%; font:inherit; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:transparent; color:var(--fg); margin:8px 0; }
  .err { color:#d1242f; }
  .muted { color:var(--sub); }
</style>
</head>
<body>
<main>
  <h1>订阅账号登录</h1>
  <p class="lead">用你已有的订阅(Claude Pro/Max、ChatGPT、GitHub Copilot 等)直接驱动 LeoPhoneAgent。凭据只存在这台 Mac 的 ~/.leoagent/oauth,不经过任何第三方。登录后回到 LeoPhoneAgent,在模型选择里找「订阅账号」即可。</p>
  <div id="list"><p class="muted">正在读取…</p></div>
  <div id="flow"></div>
</main>
<script>
const H = { "content-type": "application/json", "x-leo-ui": "1" };
const api = (path, init = {}) => fetch("/api/leo/ui/oauth" + path, { ...init, headers: { ...H, ...(init.headers || {}) } }).then(async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
});
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
let polling = null;

async function renderList() {
  const { providers } = await api("/providers");
  const list = document.getElementById("list");
  list.innerHTML = providers.map((p) => \`
    <div class="row">
      <span class="dot \${p.loggedIn ? "on" : ""}"></span>
      <div class="name"><b>\${esc(p.name)}</b><small>\${p.loggedIn ? "已登录 · " + p.modelCount + " 个模型" : "未登录"}</small></div>
      \${p.loggedIn
        ? \`<button data-logout="\${esc(p.id)}">退出</button>\`
        : \`<button class="primary" data-login="\${esc(p.id)}">登录</button>\`}
    </div>\`).join("");
  list.querySelectorAll("[data-login]").forEach((b) => b.onclick = () => startLogin(b.dataset.login));
  list.querySelectorAll("[data-logout]").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    await api("/providers/" + encodeURIComponent(b.dataset.logout) + "/logout", { method: "POST" });
    await renderList();
  });
}

async function startLogin(providerId) {
  const { flowId } = await api("/providers/" + encodeURIComponent(providerId) + "/login", { method: "POST" });
  clearInterval(polling);
  polling = setInterval(() => pollFlow(flowId), 1000);
  pollFlow(flowId);
}

async function pollFlow(flowId) {
  const flow = await api("/flows/" + flowId).catch(() => null);
  const box = document.getElementById("flow");
  if (!flow) { box.innerHTML = ""; clearInterval(polling); return; }
  const lines = [];
  for (const e of flow.events) {
    if (e.url) lines.push(\`<p>在浏览器里完成授权:<br><a href="\${esc(e.url)}" target="_blank" rel="noopener">\${esc(e.url)}</a></p>\`);
    if (e.userCode || e.user_code) lines.push(\`<p>输入这个码:</p><div class="code">\${esc(e.userCode || e.user_code)}</div>\`);
    if (e.verificationUri || e.verification_uri) lines.push(\`<p><a href="\${esc(e.verificationUri || e.verification_uri)}" target="_blank" rel="noopener">打开验证页面</a></p>\`);
    if (e.instructions) lines.push(\`<p class="muted">\${esc(e.instructions)}</p>\`);
    if (e.message && !e.url) lines.push(\`<p class="muted">\${esc(e.message)}</p>\`);
  }
  let promptHtml = "";
  if (flow.prompt && flow.prompt.type === "select") {
    promptHtml = \`<p>\${esc(flow.prompt.message)}</p>\` + (flow.prompt.options || []).map((o) =>
      \`<p><button class="primary" data-pick="\${esc(o.id)}">\${esc(o.label)}</button> <span class="muted">\${esc(o.description || "")}</span></p>\`).join("");
  } else if (flow.prompt) {
    promptHtml = \`<p>\${esc(flow.prompt.message)}</p><input id="answer" type="\${flow.prompt.type === "secret" ? "password" : "text"}" placeholder="\${esc(flow.prompt.placeholder || "")}" /><button class="primary" id="send">提交</button>\`;
  }
  const status = flow.status === "done" ? '<p style="color:var(--ok)">登录成功。回到 LeoPhoneAgent,模型选择里已经能看到这家的模型。</p>'
    : flow.status === "error" ? \`<p class="err">登录失败:\${esc(flow.error)}</p>\`
    : flow.status === "cancelled" ? '<p class="muted">已取消。</p>' : "";
  const hadFocus = document.activeElement && document.activeElement.id === "answer";
  const typed = hadFocus ? document.getElementById("answer").value : "";
  box.innerHTML = \`<div class="flow"><h2>正在登录 · \${esc(flow.provider)}</h2>\${lines.join("")}\${promptHtml}\${status}
    \${flow.status === "running" ? '<p><button id="cancel">取消</button></p>' : ""}</div>\`;
  box.querySelectorAll("[data-pick]").forEach((b) => b.onclick = () =>
    api("/flows/" + flowId + "/answer", { method: "POST", body: JSON.stringify({ value: b.dataset.pick }) }));
  if (flow.prompt && flow.prompt.type !== "select") {
    const input = document.getElementById("answer");
    if (hadFocus) { input.value = typed; input.focus(); }
    document.getElementById("send").onclick = async () => {
      await api("/flows/" + flowId + "/answer", { method: "POST", body: JSON.stringify({ value: input.value }) });
    };
  }
  const cancel = document.getElementById("cancel");
  if (cancel) cancel.onclick = () => api("/flows/" + flowId + "/cancel", { method: "POST" });
  if (flow.status !== "running") { clearInterval(polling); renderList(); }
}

renderList().catch((e) => { document.getElementById("list").innerHTML = '<p class="err">' + esc(e.message) + "</p>"; });
</script>
</body>
</html>`;
