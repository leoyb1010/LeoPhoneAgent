import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sourceApp = path.resolve(process.argv[2] || '');
const outputDir = path.resolve('release/desktop');
const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const zipName = `leocodebox-${packageJson.version}-mac-arm64.zip`;
const zipPath = path.join(outputDir, zipName);
const metadataPath = path.join(outputDir, 'latest-mac.yml');
const updateMetadataVersion = packageJson.version === '1.1.3' ? '1.36.3' : packageJson.version;

if (!sourceApp) {
  throw new Error('usage: finalize-notarized-mac-artifacts.js path/to/leocodebox.app');
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('base64')));
  });
}

run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', sourceApp]);
run('/usr/bin/xcrun', ['stapler', 'validate', sourceApp]);

await rm(zipPath, { force: true });
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', sourceApp, zipPath]);
const [sha512, zipStats] = await Promise.all([hashFile(zipPath), stat(zipPath)]);
await writeFile(metadataPath, [
  `version: ${updateMetadataVersion}`,
  'files:',
  `  - url: ${zipName}`,
  `    sha512: ${sha512}`,
  `    size: ${zipStats.size}`,
  `path: ${zipName}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  '',
].join('\n'));

console.log(`Rebuilt notarized updater ZIP: ${zipPath}`);
console.log(`Rebuilt updater metadata: ${metadataPath}`);
