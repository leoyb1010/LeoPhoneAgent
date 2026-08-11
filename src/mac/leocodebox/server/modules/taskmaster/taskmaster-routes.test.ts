import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import taskmasterRoutes from '@/modules/taskmaster/taskmaster.routes.js';

async function withTaskMasterServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/taskmaster', taskmasterRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('TaskMaster template routes are mounted through the TypeScript assembly router', async () => {
  await withTaskMasterServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/taskmaster/prd-templates`);
    assert.equal(response.status, 200);
    const payload = await response.json() as { templates?: Array<{ id?: string; content?: string }> };
    assert.ok(Array.isArray(payload.templates));
    assert.ok(payload.templates.length >= 4);
    assert.ok(payload.templates.every((template) => typeof template.id === 'string' && typeof template.content === 'string'));
  });
});

test('TaskMaster PRD writer rejects traversal filenames before project lookup', async () => {
  await withTaskMasterServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/taskmaster/prd/project-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: '../escape.md', content: 'unsafe' }),
    });
    assert.equal(response.status, 400);
    const payload = await response.json() as { error?: string };
    assert.equal(payload.error, 'Invalid filename');
  });
});
