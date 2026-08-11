import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import electronPath from 'electron';

function findTests(root) {
  const tests = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      tests.push(...findTests(filePath));
    } else if (/\.(?:test|spec)\.(?:js|ts)$/.test(entry.name)) {
      tests.push(filePath);
    }
  }
  return tests.sort();
}

const tests = findTests(path.resolve('server'));
const result = spawnSync(electronPath, ['--import', 'tsx', '--test', ...tests], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    TSX_TSCONFIG_PATH: path.resolve('server/tsconfig.json'),
  },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
