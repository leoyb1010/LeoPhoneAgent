import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageRoot = path.join(appRoot, 'native', 'mac-window');
const helper = path.join(packageRoot, 'bin', 'leo-window-helper');
const output = path.resolve(process.env.LEO_WINDOW_SMOKE_OUTPUT || path.join(packageRoot, '.build', 'smoke-evidence'));
const bundleId = 'com.leoyuan.leocodebox.window-fixture';
// A disposable, non-synced fixture bundle avoids Finder/iCloud metadata.
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'leo-window-fixture-'));
const bundle = path.join(fixtureRoot, 'LeoWindowFixture.app');
const evidence = [];
let identity = null;
let processProof = '';
let launcher;

function assertFixture(ref) {
  assert.ok(identity, 'fixture identity must be bound before any observation/action');
  assert.equal(ref.bundleId, bundleId);
  assert.equal(ref.pid, identity.pid);
  assert.equal(ref.processStartedAt, identity.processStartedAt);
}
async function native(request) {
  if (request.ref) assertFixture(request.ref);
  const started = Date.now();
  const response = await new Promise((resolve, reject) => {
    const child = execFile(helper, [], { timeout: 5000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ protocolVersion: 1, ...request }));
  });
  // Window enumeration is read-only. Never retain another application's rows.
  if (response.windows) response.windows = response.windows.filter((row) => row.bundleId === bundleId);
  if (response.observation) assertFixture(response.observation);
  evidence.push({ operation: request.operation, action: request.action?.name, windowId: request.ref?.windowId,
    elapsedMs: Date.now() - started, ok: response.ok, reason: response.reason, message: response.message, receipt: response.receipt,
    permissions: response.permissions, observation: response.observation ? {
      app: response.observation.app, pid: response.observation.pid, windowId: response.observation.windowId,
      bundleId: response.observation.bundleId, processStartedAt: response.observation.processStartedAt,
      title: response.observation.title, bounds: response.observation.bounds, frontmost: response.observation.frontmost,
      occluded: response.observation.occluded, minimized: response.observation.minimized,
      elementCount: response.observation.elements?.length, stateHash: response.observation.stateHash,
      image: response.observation.image ? { ...response.observation.image, data: '(fixture image saved separately)' } : undefined,
    } : undefined });
  return response;
}
const refFor = (row) => ({ app: row.app, pid: row.pid, windowId: row.windowId, title: row.title, bundleId: row.bundleId, processStartedAt: row.processStartedAt });
async function observe(ref, capture = false) {
  const result = await native({ operation: 'observe', ref, capture });
  if (!result.ok) {
    const captureOnly = await native({ operation: 'observe', ref, capture: true, elements: false });
    if (captureOnly.ok && captureOnly.observation?.image) await writeFile(path.join(output, 'fixture-diagnostic.jpg'), Buffer.from(captureOnly.observation.image.data, 'base64'));
  }
  assert.equal(result.ok, true, `fixture observe failed: ${result.reason}: ${result.message}`);
  return result.observation;
}
async function act(ref, kind, action, expected, requireVerified = true) {
  const result = await native({ operation: 'act', ref, kind, action,
    expected: { ...expected, ...(expected.image ? { image: { ...expected.image, data: '' } } : {}) }, expiresAt: Date.now() + 3000 });
  if (requireVerified) {
    assert.equal(result.ok, true, `fixture ${action.name} failed: ${result.reason}`);
    assert.equal(result.receipt?.verified, true);
  }
  return result;
}

await mkdir(output, { recursive: true });
try {
  const granted = await native({ operation: 'permissions' });
  assert.equal(granted.ok, true);
  if (!process.argv.includes('--fixture')) {
    console.log(JSON.stringify(granted));
  } else {
    assert.ok(Object.values(granted.permissions).every(Boolean), 'Fixture smoke requires pre-existing permissions. It will not request any.');
    const existing = await native({ operation: 'list' });
    assert.equal(existing.windows.length, 0, 'Refusing to attach to an already-running fixture');
    await exec('/usr/bin/xcrun', ['swift', 'build', '--package-path', packageRoot, '--product', 'leo-window-fixture'], { maxBuffer: 1024 * 1024 });
    await mkdir(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
    await writeFile(path.join(bundle, 'Contents', 'MacOS', 'LeoWindowFixture'), await readFile(path.join(packageRoot, '.build', 'debug', 'leo-window-fixture')), { mode: 0o755 });
    await writeFile(path.join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>LeoWindowFixture</string><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleName</key><string>Leo Window Fixture</string><key>CFBundleVersion</key><string>1</string><key>CFBundlePackageType</key><string>APPL</string><key>NSPrincipalClass</key><string>NSApplication</string><key>LSMinimumSystemVersion</key><string>14.0</string><key>NSHighResolutionCapable</key><true/></dict></plist>`);
    await exec('/usr/bin/codesign', ['--force', '--sign', '-', bundle]);
    launcher = spawn('/usr/bin/open', ['-n', '-W', bundle], { stdio: 'ignore' });
    let row;
    for (let attempt = 0; attempt < 30 && !row; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      row = (await native({ operation: 'list' })).windows.find((item) => item.title === 'Leo Window Fixture');
    }
    assert.ok(row, 'The uniquely named fixture window did not appear');
    identity = refFor(row);
    processProof = (await exec('/bin/ps', ['-p', String(identity.pid), '-o', 'lstart=,command='])).stdout;
    assert.ok(processProof.includes(path.join(bundle, 'Contents', 'MacOS', 'LeoWindowFixture')));
    let target = identity;
    // Wait for the fixture launch animation before establishing interaction evidence.
    await new Promise((resolve) => setTimeout(resolve, 600));
    let current = await observe(target);
    await act(target, 'ax', { name: 'focus' }, current);
    current = await observe(target);
    const input = current.elements.find((item) => item.identifier === 'fixture-input');
    assert.ok(input?.settableValue, 'The fixture text field must be writable');
    await act(target, 'ax', { name: 'setValue', elementId: input.id, value: 'Verified fixture text' }, current);
    current = await observe(target);
    const button = current.elements.find((item) => item.identifier === 'fixture-increment');
    assert.ok(button);
    await act(target, 'ax', { name: 'press', elementId: button.id }, current);
    current = await observe(target);
    await act(target, 'menu', { name: 'select', path: ['Fixture', 'Increment'] }, current);
    current = await observe(target, true);
    await writeFile(path.join(output, 'fixture-before-click.jpg'), Buffer.from(current.image.data, 'base64'));
    const clickButton = current.elements.find((item) => item.identifier === 'fixture-increment');
    const [wx, wy, ww, wh] = current.bounds.split(',').map(Number);
    const [bx, by, bw, bh] = clickButton.bounds.split(',').map(Number);
    await act(target, 'coord', { name: 'click', x: (bx + bw / 2 - wx) / ww, y: (by + bh / 2 - wy) / wh, coordinateSpace: 'normalized-window' }, current);
    current = await observe(target);
    await act(target, 'menu', { name: 'select', path: ['Fixture', 'Cover Target'] }, current);
    const covered = await observe(target);
    assert.equal(covered.occluded, true);
    const blocked = await act(target, 'coord', { name: 'click', x: 0.5, y: 0.5, coordinateSpace: 'normalized-window' }, covered, false);
    assert.equal(blocked.ok, false);
    assert.ok(['background-blocked', 'window-occluded'].includes(blocked.reason));
    const cover = (await native({ operation: 'list' })).windows.find((item) => item.title === 'Leo Fixture Cover');
    assert.ok(cover);
    const coverRef = refFor(cover);
    const coverState = await observe(coverRef);
    const dismiss = coverState.elements.find((item) => item.identifier === 'fixture-dismiss-cover');
    const dismissed = await act(coverRef, 'ax', { name: 'press', elementId: dismiss.id }, coverState, false);
    assert.ok(dismissed.ok || (dismissed.reason === 'window-gone' && dismissed.receipt?.attempted), 'Closing a target may be indeterminate, never fabricated');
    current = await observe(target);
    const replaced = await act(target, 'menu', { name: 'select', path: ['Fixture', 'Recreate Window'] }, current, false);
    assert.ok(replaced.ok || (replaced.reason === 'window-gone' && replaced.receipt?.attempted));
    const gone = await native({ operation: 'observe', ref: target });
    assert.equal(gone.ok, false); assert.equal(gone.reason, 'window-gone');
    const next = (await native({ operation: 'list' })).windows.find((item) => item.title === 'Leo Window Fixture' && item.windowId !== target.windowId);
    assert.ok(next); target = refFor(next);
    current = await observe(target);
    await act(target, 'ax', { name: 'minimize' }, current);
    console.log('Verified only the dedicated fixture: focus, text, press, menu, image coordinates, occlusion and window recreation.');
  }
} finally {
  if (identity && processProof) {
    try {
      const currentProof = (await exec('/bin/ps', ['-p', String(identity.pid), '-o', 'lstart=,command='])).stdout;
      if (currentProof === processProof) process.kill(identity.pid, 'SIGTERM');
    } catch { /* The fixture may already have exited when its final window closed. */ }
  }
  launcher?.kill();
  await writeFile(path.join(output, 'native-smoke.json'), JSON.stringify({ fixtureBundleId: bundleId, fixtureIdentity: identity, evidence }, null, 2));
}
