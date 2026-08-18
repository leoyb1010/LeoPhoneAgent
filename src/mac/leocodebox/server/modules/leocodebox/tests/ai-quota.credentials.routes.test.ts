import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

/**
 * [T-quota-credentials] 凭据路由的真 HTTP 冒烟。
 *
 * 存在的理由只有一条:**"完整 key 绝不回传给前端"这条保证要在真正的响应体上验,
 * 而不是在函数返回值上验。** 中间任何一层(路由拼装、错误处理、序列化)手滑
 * 把明文塞回去,单测函数是看不见的,只有真发一次请求才看得见。
 */

const realHome = os.homedir;
const realLocalOnly = process.env.LEOCODEBOX_LOCAL_ONLY;
const realFileEnv = process.env.LEOCODEBOX_QUOTA_CREDENTIALS_FILE;

type Probe = {
  call: (method: string, url: string, body?: unknown) => Promise<{ status: number; text: string }>;
  home: string;
  close: () => Promise<void>;
};

async function startProbe(): Promise<Probe> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'leo-quota-route-'));
  (os as { homedir: () => string }).homedir = () => home;
  delete process.env.LEOCODEBOX_QUOTA_CREDENTIALS_FILE;
  // 写入受 requireLocalOnly 保护 —— 桌面本地模式才允许改凭据。
  process.env.LEOCODEBOX_LOCAL_ONLY = '1';

  const routes = (await import('../ai-quota.routes.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/leocodebox', routes);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as { port: number };

  return {
    home,
    call: async (method, url, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test.afterEach(() => {
  (os as { homedir: () => string }).homedir = realHome;
  if (realLocalOnly === undefined) delete process.env.LEOCODEBOX_LOCAL_ONLY;
  else process.env.LEOCODEBOX_LOCAL_ONLY = realLocalOnly;
  if (realFileEnv === undefined) delete process.env.LEOCODEBOX_QUOTA_CREDENTIALS_FILE;
  else process.env.LEOCODEBOX_QUOTA_CREDENTIALS_FILE = realFileEnv;
});

const SECRET = 'xai-DO-NOT-LEAK-THIS-9999';

test('the API never puts a full key on the wire', async () => {
  const probe = await startProbe();
  try {
    const put = await probe.call('PUT', '/api/leocodebox/quota/credentials/grok', { apiKey: SECRET });
    assert.equal(put.status, 200);
    assert.ok(!put.text.includes('DO-NOT-LEAK'), 'PUT 的响应里出现了完整 key');

    const get = await probe.call('GET', '/api/leocodebox/quota/credentials');
    assert.equal(get.status, 200);
    assert.ok(!get.text.includes('DO-NOT-LEAK'), 'GET 的响应里出现了完整 key');

    const grok = JSON.parse(get.text).credentials.find((c: { provider: string }) => c.provider === 'grok');
    assert.equal(grok.configured, true);
    assert.equal(grok.last4, '9999', '只回传尾 4 位');
    assert.ok(!('apiKey' in grok));
  } finally {
    await probe.close();
  }
});

test('the file behind the API is 0600 and the delete route clears it', async () => {
  const probe = await startProbe();
  try {
    await probe.call('PUT', '/api/leocodebox/quota/credentials/grok', { apiKey: SECRET });
    const file = path.join(probe.home, '.leocodebox', 'quota-credentials.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);

    const del = await probe.call('DELETE', '/api/leocodebox/quota/credentials/grok');
    assert.equal(del.status, 200);
    const grok = JSON.parse(del.text).credentials.find((c: { provider: string }) => c.provider === 'grok');
    assert.equal(grok.configured, false);
    assert.equal(grok.last4, null);
  } finally {
    await probe.close();
  }
});

test('unknown providers and non-string keys are rejected, not written', async () => {
  const probe = await startProbe();
  try {
    const badProvider = await probe.call('PUT', '/api/leocodebox/quota/credentials/evil', { apiKey: 'x' });
    assert.equal(badProvider.status, 400);

    const badType = await probe.call('PUT', '/api/leocodebox/quota/credentials/grok', { apiKey: 123 });
    assert.equal(badType.status, 400);

    // 误粘贴整个文件挡在门口,别让 4KB 以上的东西落盘。
    const tooLong = await probe.call('PUT', '/api/leocodebox/quota/credentials/grok', { apiKey: 'x'.repeat(4097) });
    assert.equal(tooLong.status, 400);

    const listed = JSON.parse((await probe.call('GET', '/api/leocodebox/quota/credentials')).text);
    for (const entry of listed.credentials) assert.equal(entry.configured, false, '被拒的请求不该写进任何一项');

    const badDelete = await probe.call('DELETE', '/api/leocodebox/quota/credentials/evil');
    assert.equal(badDelete.status, 400);
  } finally {
    await probe.close();
  }
});

test('writes are refused outside local desktop mode', async () => {
  const probe = await startProbe();
  process.env.LEOCODEBOX_LOCAL_ONLY = '0';
  try {
    const put = await probe.call('PUT', '/api/leocodebox/quota/credentials/grok', { apiKey: SECRET });
    assert.equal(put.status, 403, '非本地桌面模式不许改凭据');

    // 读依然放行 —— 脱敏视图里没有秘密。
    const get = await probe.call('GET', '/api/leocodebox/quota/credentials');
    assert.equal(get.status, 200);
  } finally {
    await probe.close();
  }
});
