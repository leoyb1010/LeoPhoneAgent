import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import filesRoutes from '@/modules/files/files.routes.js';

async function withFilesServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api', filesRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('files router exposes workspace validation from the TypeScript subrouter', async () => {
  await withFilesServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/browse-filesystem?path=${encodeURIComponent('/etc')}`);
    assert.equal(response.status, 403);
    const payload = await response.json() as { error?: string };
    assert.equal(typeof payload.error, 'string');
  });
});

test('files upload route returns a JSON validation error when no files are attached', async () => {
  await withFilesServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/projects/project-1/files/upload`, {
      method: 'POST',
      body: new FormData(),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'No files provided' });
  });
});
