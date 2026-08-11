import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { getUpdateMetadataVersion } from '../../electron/versionBridge.js';

const appName = 'leocodebox.app';
const outputDir = path.resolve('release/desktop');
const sourceApp = path.join(outputDir, 'mac-arm64', appName);
const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
// Developer ID signing gates everything downstream. Without a real identity the
// build is only good for local smoke-testing, so it MUST NOT masquerade as a
// distributable release: it is renamed "-unsigned" and no updater ZIP/feed is
// produced (an ad-hoc app fails Gatekeeper on other Macs and breaks the
// Squirrel signature-continuity check on update).
const signIdentityEarly = (process.env.LEOCODEBOX_SIGN_IDENTITY || '').trim();
const dmgSuffix = signIdentityEarly ? '' : '-unsigned';
const outputDmg = path.join(outputDir, `leocodebox-${packageJson.version}-mac-arm64${dmgSuffix}.dmg`);
const outputZipName = `leocodebox-${packageJson.version}-mac-arm64.zip`;
const outputZip = path.join(outputDir, outputZipName);
const updateMetadataPath = path.join(outputDir, 'latest-mac.yml');
const updateMetadataVersion = getUpdateMetadataVersion(packageJson.version);
// Developer ID signing happens in a clean temporary directory. Every nested
// Mach-O is signed explicitly because codesign --deep does not discover native
// executables stored in arbitrary node_modules resource directories.
const signIdentity = (process.env.LEOCODEBOX_SIGN_IDENTITY || '').trim();
const signerPath = path.resolve('scripts/release/sign-macos-app.sh');
const signatureVerifierPath = path.resolve('scripts/release/verify-macos-signatures.sh');
const dmgBuilderPath = path.resolve('scripts/release/create-macos-dmg.sh');
const githubPublish = packageJson.build?.publish?.find((entry) => entry?.provider === 'github');
if (!githubPublish?.owner || !githubPublish?.repo) {
  throw new Error('package.json build.publish must define a GitHub owner and repo.');
}
const appUpdateConfig = [
  'provider: github',
  `owner: ${githubPublish.owner}`,
  `repo: ${githubPublish.repo}`,
  `private: ${githubPublish.private === true}`,
  'updaterCacheDirName: leocodebox-updater',
  '',
].join('\n');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options });
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

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'leocodebox-dmg-'));
const signedApp = path.join(tempRoot, appName);
const dmgRoot = path.join(tempRoot, 'image');

try {
  await mkdir(dmgRoot, { recursive: true });
  run('/bin/cp', ['-R', sourceApp, signedApp], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  run('/usr/bin/xattr', ['-cr', signedApp]);
  await writeFile(path.join(signedApp, 'Contents', 'Resources', 'app-update.yml'), appUpdateConfig);
  if (updateMetadataVersion !== packageJson.version) {
    run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleVersion ${updateMetadataVersion}`, path.join(signedApp, 'Contents', 'Info.plist')]);
    run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleShortVersionString ${packageJson.version}`, path.join(signedApp, 'Contents', 'Info.plist')]);
  }
  if (signIdentity) {
    run('/bin/bash', [signerPath, signedApp, signIdentity]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', signedApp]);
    run('/bin/bash', [signatureVerifierPath, signedApp]);
    console.log(`Signed with Developer ID: ${signIdentity}`);
  } else {
    run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', signedApp]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', signedApp]);
    console.warn('WARNING: LEOCODEBOX_SIGN_IDENTITY is not set — producing an AD-HOC (unsigned) build.');
    console.warn('         This build will NOT open on other Macs and MUST NOT be distributed or used as an update source.');
  }

  // Only a Developer-ID-signed app is safe to distribute and to feed the
  // auto-updater. For ad-hoc builds we skip the ZIP + latest-mac.yml entirely so
  // a broken update artifact can never be uploaded by accident.
  if (signIdentity) {
    await rm(outputZip, { force: true });
    run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', signedApp, outputZip]);
    const [zipSha512, zipStats] = await Promise.all([hashFile(outputZip), stat(outputZip)]);
    await writeFile(updateMetadataPath, [
      `version: ${updateMetadataVersion}`,
      'files:',
      `  - url: ${outputZipName}`,
      `    sha512: ${zipSha512}`,
      `    size: ${zipStats.size}`,
      `path: ${outputZipName}`,
      `sha512: ${zipSha512}`,
      `releaseDate: '${new Date().toISOString()}'`,
      '',
    ].join('\n'));
  } else {
    // Stale metadata from a previous signed build must not linger next to an
    // unsigned DMG and get mistaken for this build's release artifacts.
    await rm(outputZip, { force: true });
    await rm(updateMetadataPath, { force: true });
  }

  run('/usr/bin/ditto', ['--norsrc', '--noqtn', signedApp, path.join(dmgRoot, appName)]);
  await symlink('/Applications', path.join(dmgRoot, 'Applications'));
  await rm(outputDmg, { force: true });
  run('/bin/bash', [dmgBuilderPath, dmgRoot, outputDmg]);
  console.log(`Created ${signIdentity ? 'signed' : 'UNSIGNED'} DMG: ${outputDmg}`);
  if (signIdentity) {
    console.log(`Created updater ZIP: ${outputZip}`);
    console.log(`Created updater metadata: ${updateMetadataPath}`);
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
