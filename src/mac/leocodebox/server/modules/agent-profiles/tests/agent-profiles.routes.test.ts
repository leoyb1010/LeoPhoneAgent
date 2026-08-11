import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';
import type { ErrorRequestHandler } from 'express';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { userDb } from '@/modules/database/repositories/users.js';
import { AppError } from '@/shared/utils.js';

import agentProfilesRoutes from '../agent-profiles.routes.js';

// Minimal stand-in for server/index.ts globalErrorHandler (AppError -> statusCode).
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
    return;
  }
  res.status(500).json({ success: false, error: { message: 'Internal error' } });
};

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-profiles-routes-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  const user = userDb.createUser('routes-user', 'hash');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { user: { id: number } }).user = { id: Number(user.id) }; next(); });
  app.use('/api/agent-profiles', agentProfilesRoutes);
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}/api/agent-profiles`;
  try {
    await run(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(dir, { recursive: true, force: true });
  }
}

const post = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('POST / creates a valid profile (201) and GET / lists it', async () => {
  await withServer(async (base) => {
    const created = await post(base, '', { name: '审查员', provider: 'claude', permissionMode: 'plan' });
    assert.equal(created.status, 201);
    const list = await fetch(base).then((r) => r.json()) as { data: { profiles: unknown[] } };
    assert.equal(list.data.profiles.length, 1);
  });
});

test('POST / rejects an over-length field with 400 (no silent truncation)', async () => {
  await withServer(async (base) => {
    const res = await post(base, '', { name: 'a'.repeat(200) });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: { code: string } };
    assert.equal(body.error.code, 'AGENT_PROFILE_FIELD_TOO_LONG');
  });
});

test('POST /import rejects non-object elements with 400', async () => {
  await withServer(async (base) => {
    const res = await post(base, '/import', { profiles: [null, 42, 'junk'] });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: { code: string } };
    assert.equal(body.error.code, 'AGENT_PROFILE_IMPORT_INVALID');
  });
});

test('POST /import rejects an oversized batch with 413', async () => {
  await withServer(async (base) => {
    const profiles = Array.from({ length: 501 }, (_, index) => ({ name: `p${index}` }));
    const res = await post(base, '/import', { profiles });
    assert.equal(res.status, 413);
    const body = await res.json() as { error: { code: string } };
    assert.equal(body.error.code, 'AGENT_PROFILE_IMPORT_TOO_LARGE');
  });
});

test('POST /import accepts a valid batch (201)', async () => {
  await withServer(async (base) => {
    const res = await post(base, '/import', { profiles: [{ name: 'A' }, { name: 'B', provider: 'codex' }] });
    assert.equal(res.status, 201);
    const body = await res.json() as { data: { count: number } };
    assert.equal(body.data.count, 2);
  });
});

test('GET /:id for a missing profile returns 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
  });
});
