/**
 * Real end-to-end smoke test (NOT a unit test — launches a real browser).
 * Run: node --import tsx scripts/smoke.mjs  [url]
 *
 * Drives the runtime through: status → start → navigate → snapshot →
 * screenshot → tabs → stop, printing each step's result. Uses the locally
 * detected Chrome (vendored executable detection); no extension required.
 */
import { createBrowserControlRuntime } from '../src/runtime.ts';

const url = process.argv[2] ?? 'https://example.com';

const rt = createBrowserControlRuntime({
  config: {
    browser: {
      enabled: true,
      headless: true,
      // default managed profile; SSRF allows private net for loopback control
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    },
  },
  logSink: (level, scope, args) => {
    if (level === 'warn' || level === 'error') console.error(`[${level}:${scope}]`, ...args);
  },
});

function show(label, res) {
  const dataPreview =
    typeof res.data === 'object' && res.data
      ? JSON.stringify(res.data).slice(0, 300)
      : String(res.data).slice(0, 300);
  console.log(
    `\n== ${label} == ok=${res.ok} status=${res.status ?? '-'} ${res.errorCode ?? ''}\n   ${res.message ?? dataPreview}`,
  );
  return res;
}

async function main() {
  show('status', await rt.call({ action: 'status' }));
  show('doctor', await rt.call({ action: 'doctor' }));
  show('start', await rt.call({ action: 'start' }));
  show('navigate', await rt.call({ action: 'navigate', url }));
  const snap = show('snapshot', await rt.call({ action: 'snapshot', snapshotFormat: 'ai', interactive: true }));
  show('screenshot', await rt.call({ action: 'screenshot', type: 'jpeg' }));
  show('tabs', await rt.call({ action: 'tabs' }));
  show('stop', await rt.call({ action: 'stop' }));

  const navOk = snap.ok;
  console.log(`\n=== SMOKE ${navOk ? 'PASS' : 'FAIL'} (snapshot ok=${navOk}) ===`);
  process.exit(navOk ? 0 : 1);
}

main().catch((err) => {
  console.error('\n=== SMOKE CRASH ===\n', err);
  process.exit(2);
});
