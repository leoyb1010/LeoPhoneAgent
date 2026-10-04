import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const base = process.env.PAPERCLIP_SMOKE_URL || "http://127.0.0.1:43168";
const url = new URL(base);
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "仅允许隔离的回环测试服务器");
const output = resolve(process.env.PAPERCLIP_SMOKE_OUTPUT || "paperclip-runtime-results");
await mkdir(output, { recursive: true });
const checks = [];
const cookies = new Map();
async function api(path, method = "GET", body, authenticated = true) {
  const response = await fetch(base + path, {
    method, redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/json", Origin: base,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(authenticated && cookies.size ? { Cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join("; ") } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (authenticated) for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";", 1)[0]; const index = pair.indexOf("=");
    cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error(`${method} ${path} 返回非JSON (${response.status})`); }
  // 错误只记录HTTP路径/状态，不把会话Cookie、随机密码、注册响应写入工件。
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
  return data;
}
async function record(name, work) { await work(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
async function until(work, accept, limitMs = 60_000) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) { const value = await work(); if (accept(value)) return value; await new Promise(r => setTimeout(r, 1000)); }
  throw new Error("等待服务器状态转换超时");
}
let user, company, issue, agent;
try {
  await record("真实服务器健康与认证模式", async () => {
    const health = await api("/api/health", "GET", undefined, false);
    assert.equal(health.status, "ok"); assert.equal(health.deploymentMode, "authenticated");
  });
  const email = `smoke-${randomUUID()}@example.invalid`;
  const password = randomBytes(32).toString("base64url");
  await record("真实Better Auth注册、注销、登录及人类会话", async () => {
    await api("/api/auth/sign-up/email", "POST", { name: "隔离验证用户", email, password });
    user = (await api("/api/auth/get-session")).user; assert.ok(user.id);
    await api("/api/auth/sign-out", "POST", {}); cookies.clear();
    assert.equal(await api("/api/auth/get-session"), null);
    await api("/api/auth/sign-in/email", "POST", { email, password });
    assert.equal((await api("/api/auth/get-session")).user.id, user.id);
    await api("/api/bootstrap/claim", "POST", {});
  });
  await record("公司隔离与Cookie鉴权", async () => {
    company = await api("/api/companies", "POST", { name: "中文集成验证", description: "一次性CI测试数据" });
    const listed = await api("/api/companies?scope=accessible"); assert.ok(listed.some(c => c.id === company.id));
    const response = await fetch(`${base}/api/companies/${company.id}/issues`, { signal: AbortSignal.timeout(10000) });
    assert.ok([401,403].includes(response.status), "未登录请求不得读取任务");
    await api(`/api/companies/${company.id}`, "PATCH", { requireBoardApprovalForNewAgents: false });
  });
  await record("任务真实持久化及创建去重", async () => {
    const input = { title: "验证中文任务", description: "服务器真实API，不调用任何模型", status: "backlog", idempotencyKey: randomUUID() };
    issue = await api(`/api/companies/${company.id}/issues`, "POST", input);
    const duplicate = await api(`/api/companies/${company.id}/issues`, "POST", input);
    assert.equal(duplicate.id, issue.id);
    assert.equal((await api(`/api/issues/${issue.id}`)).companyId, company.id);
  });
  await record("回复真实去重、任务状态及文档产物", async () => {
    const body = { body: "中文回复：检查异步执行", clientRequestId: randomUUID() };
    const a = await api(`/api/issues/${issue.id}/comments`, "POST", body);
    const b = await api(`/api/issues/${issue.id}/comments`, "POST", body); assert.equal(a.id,b.id);
    const comments = await api(`/api/issues/${issue.id}/comments?order=asc`); assert.equal(comments.filter(c=>c.clientRequestId===body.clientRequestId).length,1);
    const updated = await api(`/api/issues/${issue.id}`, "PATCH", { status: "blocked" }); assert.equal(updated.status,"blocked");
    await api(`/api/issues/${issue.id}/documents/output`, "PUT", { title:"中文验证产物", format:"markdown", body:"服务器保存的中文产物" });
    const doc = await api(`/api/issues/${issue.id}/documents/output`); assert.equal(doc.body,"服务器保存的中文产物");
  });
  await record("任务关联审批真实提交与读取", async () => {
    const approval = await api(`/api/companies/${company.id}/approvals`, "POST", { type:"approve_ceo_strategy", payload:{ strategy:"仅验证CI审批，不执行外部操作" }, issueIds:[issue.id] });
    const linked = await api(`/api/issues/${issue.id}/approvals`); assert.ok(linked.some(a=>a.id===approval.id));
    const decision = await api(`/api/approvals/${approval.id}/approve`, "POST", { decisionNote:"隔离测试已核对" }); assert.equal(decision.status,"approved");
  });
  await record("官方process适配器异步运行及真实日志", async () => {
    agent = await api(`/api/companies/${company.id}/agents`, "POST", { name:"确定性测试执行器", role:"ceo", adapterType:"process", adapterConfig:{ command:process.execPath, args:["-e", "console.log('中文fixture执行完成')"], timeoutSec:20 } });
    // 与原生客户端相同：任务指派后等待服务器创建运行，不拿POST成功当执行成功。
    await api(`/api/issues/${issue.id}`, "PATCH", { assigneeAgentId:agent.id, status:"todo" });
    const linked = await until(()=>api(`/api/issues/${issue.id}/runs`), rows=>rows.some(r=>r.agentId===agent.id && r.runId));
    const accepted = linked.find(r=>r.agentId===agent.id && r.runId);
    const run = await until(()=>api(`/api/heartbeat-runs/${accepted.runId}`), r=>["succeeded","failed","cancelled","timed_out"].includes(r.status));
    assert.equal(run.companyId,company.id);
    assert.equal(run.status,"succeeded");
    const log = await api(`/api/heartbeat-runs/${run.id}/log?offset=0&limitBytes=256000`); assert.match(log.content,/中文fixture执行完成/);
  });
  await record("真实运行取消不会被误当作普通POST完成", async () => {
    await api(`/api/agents/${agent.id}`, "PATCH", { adapterConfig:{ command:process.execPath, args:["-e","console.log('等待取消');setTimeout(()=>{},60000)"], timeoutSec:90 } });
    const accepted = await api(`/api/agents/${agent.id}/heartbeat/invoke`, "POST", { idempotencyKey:randomUUID() });
    assert.ok(accepted.id);
    await until(()=>api(`/api/heartbeat-runs/${accepted.id}`), r=>r.status==="running");
    await api(`/api/heartbeat-runs/${accepted.id}/cancel`, "POST", {});
    const cancelled = await until(()=>api(`/api/heartbeat-runs/${accepted.id}`), r=>["cancelled","succeeded","failed","timed_out"].includes(r.status));
    assert.equal(cancelled.status,"cancelled");
  });
  await record("注销后会话失效", async () => { await api("/api/auth/sign-out","POST",{}); cookies.clear(); assert.equal(await api("/api/auth/get-session"),null); });
  await writeFile(resolve(output,"summary.json"),JSON.stringify({ passed:true, checks, server:"fixed-upstream-real-http", auth:"real-Better-Auth-cookie", execution:"upstream-process-adapter-deterministic-node-command", realProviderUsed:false, productionDeployment:false, nativeRunnerProviderTested:false },null,2));
} catch (error) {
  await writeFile(resolve(output,"summary.json"),JSON.stringify({passed:false,checks,error:String(error),realProviderUsed:false,productionDeployment:false},null,2));
  throw error;
}
