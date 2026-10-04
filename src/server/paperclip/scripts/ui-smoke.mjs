#!/usr/bin/env node
// Tests built upstream UI against deterministic local API fixtures. Never a real server/agent.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const home = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.argv[2] || path.join(home, '.upstream'));
const require = createRequire(path.join(root, 'package.json'));
const { chromium, expect } = require('@playwright/test');
const dist = path.join(root, 'ui/dist');
assert.ok(fs.existsSync(path.join(dist, 'index.html')), 'Run the upstream UI build before browser smoke tests');
const reportDir = path.join(home, 'reports/ui-smoke'); fs.mkdirSync(reportDir, { recursive: true });
let mode = process.argv.includes('--board') ? 'board' : 'auth';
const companyId = '11111111-1111-4111-8111-111111111111';
const company = { id: companyId, name: '原样保留的用户组织 English Name', description: '', status: 'active', issuePrefix: 'ZH', issueCounter: 0, budgetMonthlyCents: 10000, spentMonthlyCents: 0, requireBoardApprovalForNewAgents: true, createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z' };
const requestLog = [];
const unknownRequests = [];
// Explicit array-returning API contracts used by the tested shell and pages.
const emptyArrayPaths = new Set([
  '/api/adapters', '/api/plugins', '/api/plugins/ui-contributions',
  ...['projects', 'agents', 'issues', 'approvals', 'join-requests', 'inbox-dismissals',
    'heartbeat-runs', 'live-runs', 'skills', 'routines', 'environments', 'org']
    .map(resource => `/api/companies/${companyId}/${resource}`),
]);
const boardFixture = JSON.parse(fs.readFileSync(path.join(home, "overlays/smoke-board-fixture.json")));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    requestLog.push({ method: req.method, path: url.pathname });
    let body; let status = 200;
    if (url.pathname === '/api/health') body = { status: 'ok', deploymentMode: mode === 'auth' ? 'authenticated' : 'local_trusted', deploymentExposure: 'private', authReady: true, bootstrapStatus: 'ready', features: {} };
    else if (url.pathname === '/api/auth/get-session') body = null;
    else if (url.pathname === '/api/auth/sign-in/email') { status = 401; body = { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' }; }
    else if (url.pathname === '/api/companies') body = mode === 'auth' ? [] : [company];
    else if (url.pathname === '/api/companies/' + companyId) body = company;
    else if (url.pathname.endsWith('/dashboard')) body = boardFixture.dashboard;
    else if (url.pathname.endsWith('/resource-memberships/me')) body = boardFixture.memberships;
    else if (url.pathname === '/api/announcements/current') body = null;
    else if (url.pathname === '/api/cli-auth/me') body = { actorType: 'board', userId: 'local-board', isInstanceAdmin: true, companyIds: [companyId] };
    else if (url.pathname === '/api/instance/settings') body = boardFixture.instanceSettings;
    else if (url.pathname === '/api/instance/settings/experimental') body = boardFixture.instanceSettings.experimental;
    else if (url.pathname === '/api/instance/settings/general') body = boardFixture.instanceSettings.general;
    else if (url.pathname === `/api/companies/${companyId}/sidebar-badges`) body = boardFixture.sidebarBadges;
    else if (url.pathname === `/api/companies/${companyId}/environments/capabilities`) body = boardFixture.environmentCapabilities;
    else if (req.method === 'GET' && url.pathname === '/api/agent-avatars/cap-v1/muted-dream/sleepy.png') {
      // Exercise the upstream documented 503 fallback instead of running the image worker.
      status = 503; body = { error: 'Avatar temporarily unavailable' };
    }
    else if (url.pathname.endsWith('/budgets/overview')) body = boardFixture.budgets;
    else if (url.pathname.endsWith('/costs/summary')) body = boardFixture.costSummary;
    else if (url.pathname.endsWith('/costs/finance-summary')) body = boardFixture.financeSummary;
    else if (req.method === 'GET' && emptyArrayPaths.has(url.pathname)) body = [];
    else if (req.method === 'GET' && url.pathname === `/api/companies/${companyId}/events/ws`) {
      // Live WebSocket delivery is deliberately outside this static-UI fixture.
      status = 426; body = { error: 'Fixture does not stream live events' };
    } else {
      unknownRequests.push({ method: req.method, path: url.pathname });
      status = 501; body = { error: 'Unregistered browser fixture API' };
    }
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); return;
  }
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  let file = path.resolve(dist, relative);
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(dist, 'index.html');
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
if (process.argv.includes("--serve-only")) {
  console.log(JSON.stringify({ origin, mode, fixtureOnly: true }));
  await new Promise(() => {});
}
let browser;
let page;
const errors = [];
const results = [];
try {
  const executablePath = process.env.PAPERCLIP_TEST_CHROMIUM || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  // Any accidental external request is blocked, including telemetry and provider URLs.
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /Page render failed|App render failed/.test(message.text())) errors.push(message.text()); });
  await page.goto(origin + '/auth');
  await page.getByRole('heading', { name: '登录 Paperclip', exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  await page.getByLabel('邮箱', { exact: true }).fill('fixture@example.invalid');
  await page.getByLabel('密码', { exact: true }).fill('not-a-real-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByText('邮箱或密码不正确，请检查后重试。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '查看原始诊断' }).click();
  await page.getByText('Invalid email or password', { exact: true }).waitFor();
  await page.getByRole('button', { name: '收起原始诊断' }).click();
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await page.getByRole('heading', { name: '创建 Paperclip 账号', exact: true }).waitFor();
  await page.getByLabel('名称', { exact: true }).waitFor();
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '登录 Paperclip', exact: true }).waitFor();
  await page.screenshot({ path: path.join(reportDir, 'auth-zh-CN.png'), fullPage: true });
  results.push({ surface: '登录/注册切换、模拟401、中文错误、原始诊断展开/收起', passed: true });
  mode = 'board';
  for (const [route, text, name] of [
    ['/ZH/approvals/pending', '没有待处理的审批。', 'approvals'],
    ['/ZH/agents/all', '创建第一个智能体，即可开始使用。', 'agents'],
    ['/ZH/company/settings', '组织名称', 'settings'],
    ['/ZH/activity/budgets', '预算控制台', 'budgets'],
  ]) {
    await page.goto(origin + route);
    await page.getByText(text, { exact: true }).first().waitFor({ timeout: 20000 });
    // React ErrorBoundary catches failures without pageerror; navigation labels never establish page health.
    await expect(page.getByRole('heading', { name: /^(此页面发生错误|Paperclip 发生错误)$/ })).toHaveCount(0);
    await expect(page.getByText('Something went wrong', { exact: true })).toHaveCount(0);
    assert.ok((await page.locator('body').textContent()).includes(company.name), 'User-provided organization text changed');
    await expect(page.getByText('用户', { exact: true }).first()).toBeVisible();
    if (name === 'agents') {
      const create = page.getByRole('button', { name: '新建智能体', exact: true }).first();
      await expect(create).toBeEnabled();
      await create.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } else if (name === 'settings') {
      await expect(page.getByRole('textbox').first()).toHaveValue(company.name);
      await expect(page.getByText('选择文件', { exact: true })).toBeVisible();
      await expect(page.getByText('未选择文件', { exact: true })).toBeVisible();
      const fileInput = page.getByLabel('选择组织标志图片', { exact: true });
      await expect(fileInput).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml');
      await expect(fileInput).toHaveCSS('opacity', '0');
    } else if (name === 'budgets') {
      await expect(page.getByText('尚未处理的预警或强制停止超限事件', { exact: true })).toBeVisible();
      await expect(page.getByRole('tab', { name: '预算', exact: true })).toBeEnabled();
    }
    await expect(page.getByRole('heading', { name: /^(此页面发生错误|Paperclip 发生错误)$/ })).toHaveCount(0);
    assert.deepEqual(errors, [], `Browser or caught React render errors on ${name}`);
    assert.deepEqual(unknownRequests, [], `Unregistered browser fixture requests on ${name}`);
    await page.screenshot({ path: path.join(reportDir, name + '-zh-CN.png'), fullPage: true });
    results.push({ surface: name, passed: true });
  }
  assert.deepEqual(errors, [], 'Browser runtime errors');
  fs.writeFileSync(path.join(reportDir, 'results.json'), JSON.stringify({ kind: 'built-ui-local-fixtures', results, requests: requestLog, externalRequests: 'blocked', unknownRequests, realServerIntegration: false }, null, 2));
  console.log(JSON.stringify({ passed: true, results, reportDir }, null, 2));
} catch (error) {
  if (page) {
    try { await page.screenshot({ path: path.join(reportDir, 'failure.png'), fullPage: true }); } catch {}
    try { fs.writeFileSync(path.join(reportDir, 'failure-body.txt'), await page.locator('body').innerText()); } catch {}
  }
  fs.writeFileSync(path.join(reportDir, 'results.json'), JSON.stringify({ passed: false, results, error: String(error), pageErrors: errors, url: page?.url(), requests: requestLog, unknownRequests, realServerIntegration: false }, null, 2));
  throw error;
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
