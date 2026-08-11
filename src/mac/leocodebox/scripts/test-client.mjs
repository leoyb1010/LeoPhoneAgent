import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function findTests(root) {
  const tests = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) tests.push(...findTests(filePath));
    else if (/\.test\.(?:ts|tsx)$/.test(entry.name)) tests.push(filePath);
  }
  return tests.sort();
}

const tests = findTests(path.resolve('src'));
if (tests.length === 0) throw new Error('No client tests found.');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
