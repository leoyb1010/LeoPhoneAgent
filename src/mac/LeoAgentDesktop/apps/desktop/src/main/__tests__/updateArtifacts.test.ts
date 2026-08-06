import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanOldUpdateFiles } from '../updateArtifacts';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-update-artifacts-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('update artifact isolation', () => {
  it('普通 hotfix 清理保留其它子目录及当前包 sidecar', () => {
    const otherDir = path.join(root, 'other-update-flow');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'payload.zip'), 'payload');
    for (const file of ['old.zip', 'current.zip', 'current.zip.meta.json', 'patch-info.json']) {
      fs.writeFileSync(path.join(root, file), file);
    }

    cleanOldUpdateFiles(root, 'current.zip', ['patch-info.json']);

    expect(fs.existsSync(path.join(root, 'old.zip'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'current.zip'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'current.zip.meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(otherDir, 'payload.zip'))).toBe(true);
  });

});
