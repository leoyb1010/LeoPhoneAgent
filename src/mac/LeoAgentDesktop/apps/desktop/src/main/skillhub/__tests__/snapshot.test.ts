import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const userDataDir = path.join(os.tmpdir(), 'xdt-skillhub-snapshot-test-userdata');

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected app.getPath(${name})`);
      return userDataDir;
    },
  },
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  maskPath: (value: string) => value,
}));

function writeFile(dir: string, relPath: string, content: string): void {
  const filePath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-skillhub-snapshot-test-'));
}

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('skillhub/snapshot', () => {
  it('keeps declared dotfile fixtures and excludes sensitive dotfiles', async () => {
    const dir = makeTmpDir();
    try {
      writeFile(dir, 'SKILL.md', 'skill');
      writeFile(dir, '.cca-bindings.json', '{"task":"demo"}');
      writeFile(dir, '.cca-state/task/current-goal.md', 'goal');
      writeFile(dir, '.env', 'TOKEN=secret');
      writeFile(dir, '.envrc', 'export TOKEN=secret');
      writeFile(dir, '.ssh/id_rsa', 'private key');
      writeFile(dir, '.aws/credentials', 'aws_secret_access_key=secret');
      writeFile(dir, '.docker/config.json', '{"auths":{"example.com":{}}}');
      writeFile(dir, '.gem/credentials', ':rubygems_api_key: secret');
      writeFile(dir, '.config/gcloud/application_default_credentials.json', '{"client_secret":"secret"}');
      writeFile(dir, 'fixtures/.docker/config.json', '{"auths":{"example.com":{}}}');
      writeFile(dir, 'fixtures/.gem/credentials', ':rubygems_api_key: secret');
      writeFile(dir, 'fixtures/.config/gcloud/application_default_credentials.json', '{"client_secret":"secret"}');
      writeFile(dir, '.kube/config', 'token: secret');
      writeFile(dir, '.config/gh/hosts.yml', 'oauth_token: secret');
      writeFile(dir, '.azure/accessTokens.json', '[]');
      writeFile(dir, 'keys/id_ed25519', 'private key');
      writeFile(dir, 'certs/client.pem', 'private key');
      writeFile(dir, '.config/tool/settings.json', '{"fixture":true}');
      writeFile(dir, 'node_modules/pkg/index.js', 'module');

      const { getSnapshotPath, writeSnapshot } = await import('../snapshot');
      await writeSnapshot(dir, 'demo-skill');

      const snapshotDir = getSnapshotPath('demo-skill');
      expect(fs.existsSync(path.join(snapshotDir, '.cca-bindings.json'))).toBe(true);
      expect(fs.existsSync(path.join(snapshotDir, '.cca-state/task/current-goal.md'))).toBe(true);
      expect(fs.existsSync(path.join(snapshotDir, '.env'))).toBe(false);
      expect(fs.existsSync(path.join(snapshotDir, '.envrc'))).toBe(false);
      expect(fs.existsSync(path.join(snapshotDir, '.ssh/id_rsa'))).toBe(false);
      expect(fs.existsSync(path.join(snapshotDir, '.aws/credentials'))).toBe(false);
      expect(fs.existsSync(path.join(snapshotDir, '.docker/config.json'))).toBe(false);
      expect(fs.existsSync(path.join(snapshotDir, '.gem/credentials'))).toBe(false);
      expect(fs.existsSync(path.join(snapshotDir, '.config/gcloud/application_default_credentials.json'))).toBe(false);
      expect(fs.existsSync(path.join(snapshotDir, 'fixtures/.docker/config.json'))).toBe(false);
      expect(fs.existsSync(path.join(snapshotDir, 'fixtures/.gem/credentials'))).toBe(false);
      expect(fs.existsSync(path.join(snapshotDir, 'fixtures/.config/gcloud/application_default_credentials.json'))).toBe(false);
      expect(fs.existsSync(path.join(snapshotDir, '.kube/config'))).toBe(false);
      expect(fs.existsSync(path.join(snapshotDir, '.config/gh/hosts.yml'))).toBe(false);
      expect(fs.existsSync(path.join(snapshotDir, '.azure/accessTokens.json'))).toBe(false);
      expect(fs.existsSync(path.join(snapshotDir, 'keys/id_ed25519'))).toBe(false);
      expect(fs.existsSync(path.join(snapshotDir, 'certs/client.pem'))).toBe(false);
      expect(fs.existsSync(path.join(snapshotDir, '.config/tool/settings.json'))).toBe(true);
      expect(fs.existsSync(path.join(snapshotDir, 'node_modules/pkg/index.js'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports dotfile fixture changes in snapshot diff', async () => {
    const dir = makeTmpDir();
    try {
      writeFile(dir, 'SKILL.md', 'skill');
      writeFile(dir, '.cca-bindings.json', '{"task":"old"}');

      const { computeSnapshotDiff, writeSnapshot } = await import('../snapshot');
      await writeSnapshot(dir, 'demo-skill');
      writeFile(dir, '.cca-bindings.json', '{"task":"new"}');
      writeFile(dir, '.env', 'TOKEN=changed-but-ignored');

      const diff = await computeSnapshotDiff(dir, 'demo-skill');
      expect(diff.hasSnapshot).toBe(true);
      expect(diff.changes.map((change) => change.path)).toEqual(['.cca-bindings.json']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
