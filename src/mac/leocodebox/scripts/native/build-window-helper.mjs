import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageRoot = path.join(appRoot, 'native', 'mac-window');
const destination = path.join(packageRoot, 'bin', 'leo-window-helper');
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn('/usr/bin/xcrun', ['swift', ...args], { stdio: 'inherit', cwd: appRoot });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Swift build exited ${code}`)));
});
if (process.platform !== 'darwin') throw new Error('The native window helper must be built on macOS.');
await run(['build', '--package-path', packageRoot, '--configuration', 'release', '--product', 'leo-window-helper']);
await mkdir(path.dirname(destination), { recursive: true });
await copyFile(path.join(packageRoot, '.build', 'release', 'leo-window-helper'), destination);
const bytes = await readFile(destination);
await writeFile(`${destination}.sha256`, `${createHash('sha256').update(bytes).digest('hex')}  leo-window-helper\n`);
console.log(`Built ${destination}. Sign and include this helper in the app's native/mac-window/bin directory during release packaging.`);
