/**
 * Manual end-to-end test for parallelDownload resume behavior.
 *
 * 1. Full download → capture baseline size + sha256
 * 2. Truncate to 30%, rename to .tmp  (simulates a crashed/interrupted download)
 * 3. Re-invoke parallelDownload  → should send Range, append, finish
 * 4. Compare sha256 against baseline + verify first progress tick reflects
 *    the resume offset (not zero)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parallelDownload, type DownloadProgress } from '../src/main/parallelDownload';

const URL = process.argv[2];
if (!URL) {
  console.error('Usage: tsx test-resume.mts <url>');
  process.exit(1);
}

const DEST = path.join(os.tmpdir(), `resume-test-${Date.now()}.bin`);
const TMP = DEST + '.tmp';

function cleanup() {
  for (const p of [DEST, TMP]) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

function makeLogger(label: string) {
  let lastLogged = 0;
  const firstTick: { received: number | null } = { received: null };
  const cb = (p: DownloadProgress) => {
    if (firstTick.received === null) firstTick.received = p.received;
    if (p.received - lastLogged > 4 * 1024 * 1024 || p.percent === 100) {
      process.stdout.write(
        `  [${label}] ${p.percent}%  ${(p.received / 1024 / 1024).toFixed(1)}/${(p.total / 1024 / 1024).toFixed(1)} MB\n`,
      );
      lastLogged = p.received;
    }
  };
  return { cb, firstTick };
}

async function main() {
  cleanup();
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  console.log('[1/4] Full download (baseline) ...');
  const t0 = Date.now();
  const baseline = makeLogger('full');
  const first = await parallelDownload(URL, DEST, undefined, baseline.cb);
  if (!first) { console.error('❌ initial download returned null'); cleanup(); process.exit(1); }
  const fullSize = fs.statSync(DEST).size;
  const fullHash = await sha256(DEST);
  console.log(`    size=${fullSize}  sha256=${fullHash.slice(0, 16)}…  took ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log('[2/4] Truncating to ~30% and renaming to .tmp ...');
  const partialSize = Math.floor(fullSize * 0.3);
  const buf = fs.readFileSync(DEST).subarray(0, partialSize);
  fs.writeFileSync(TMP, buf);
  fs.unlinkSync(DEST);
  const tmpSize = fs.statSync(TMP).size;
  console.log(`    .tmp = ${tmpSize} bytes (${((tmpSize / fullSize) * 100).toFixed(1)}% of full)`);

  console.log('[3/4] Calling parallelDownload again — should resume via Range ...');
  const t1 = Date.now();
  const resumed = makeLogger('resume');
  const second = await parallelDownload(URL, DEST, undefined, resumed.cb);
  if (!second) { console.error('❌ resume returned null'); cleanup(); process.exit(1); }
  const resumedSize = fs.statSync(DEST).size;
  const resumedHash = await sha256(DEST);
  console.log(`    size=${resumedSize}  sha256=${resumedHash.slice(0, 16)}…  took ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  console.log('[4/4] Verification:');
  const checks = [
    { name: 'final size matches baseline', ok: resumedSize === fullSize, detail: `${resumedSize} vs ${fullSize}` },
    { name: 'sha256 matches baseline    ', ok: resumedHash === fullHash, detail: resumedHash === fullHash ? 'identical' : `${resumedHash.slice(0, 16)}… vs ${fullHash.slice(0, 16)}…` },
    { name: 'first progress tick ≥ partialSize (resume, not restart)', ok: (resumed.firstTick.received ?? 0) >= tmpSize, detail: `first=${resumed.firstTick.received} partial=${tmpSize}` },
  ];
  for (const c of checks) {
    console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}  —  ${c.detail}`);
  }

  cleanup();
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e); cleanup(); process.exit(1); });
