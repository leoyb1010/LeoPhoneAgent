/**
 * Browser capability benchmark — quantifies the token proxy (tool-result payload
 * size) for the "blind probing" baseline vs the new efficient primitives, on
 * public demo sites. NOT a unit test — launches a real headless Chrome (like
 * scripts/smoke.mjs) and hits the network.
 *
 * Run:  node --import tsx scripts/browser-capability-benchmark.mjs
 *   (or pnpm benchmark:browser)
 *
 * For each task it compares:
 *   baseline  = a full-page `snapshot` (what blind probing feeds the model)
 *   enhanced  = a targeted `extract` (just the fields the task needs)
 * and reports the character count (≈ tokens/4) reduction. A report JSON is
 * written under os.tmpdir()/xdt-browser-capability-benchmark/.
 *
 * The recipe/network paths additionally collapse round-trips; this harness
 * focuses on the payload-size axis because it is the dominant, deterministic
 * token driver and is measurable without a live agent session. Full
 * agent-session cache-hit-rate comparison is a manual run in the app
 * (see upstream/MAINTAINING.md).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBrowserControlRuntime } from '../packages/browser-control-runtime/src/runtime.ts';
import { buildExtractFnSource } from '../packages/lizi-mcps/src/browser/extract.ts';

/** Tasks: a demo URL + the targeted extract spec the task actually needs. */
const TASKS = [
  {
    name: 'books.toscrape.com — list books',
    url: 'https://books.toscrape.com/',
    extract: {
      from: 'article.product_pod',
      multiple: true,
      fields: { title: { selector: 'h3 a', attr: 'title' }, price: '.price_color' },
    },
  },
  {
    name: 'quotes.toscrape.com — list quotes',
    url: 'https://quotes.toscrape.com/',
    extract: {
      from: '.quote',
      multiple: true,
      fields: { text: '.text', author: '.author' },
    },
  },
];

const APPROX_CHARS_PER_TOKEN = 4;
const reportDir = path.join(os.tmpdir(), 'xdt-browser-capability-benchmark');
const reportPath = path.join(reportDir, 'last-report.json');

function chars(value) {
  return typeof value === 'string' ? value.length : JSON.stringify(value ?? null).length;
}

function pct(before, after) {
  if (before <= 0) return 0;
  return Math.round(((before - after) / before) * 1000) / 10;
}

const rt = createBrowserControlRuntime({
  config: {
    browser: {
      enabled: true,
      headless: true,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    },
  },
  logSink: (level, scope, args) => {
    if (level === 'warn' || level === 'error') console.error(`[${level}:${scope}]`, ...args);
  },
});

async function runTask(task) {
  await rt.call({ action: 'navigate', url: task.url });
  await rt.call({ action: 'act', request: { kind: 'wait', loadState: 'load' } });

  const baseline = await rt.call({ action: 'snapshot', snapshotFormat: 'ai', interactive: true });
  const enhanced = await rt.call({
    action: 'act',
    request: { kind: 'evaluate', fn: buildExtractFnSource(task.extract) },
  });

  const baselineChars = chars(baseline.data);
  const enhancedChars = chars(enhanced.data);
  return {
    task: task.name,
    url: task.url,
    baselineOk: baseline.ok,
    enhancedOk: enhanced.ok,
    baselineChars,
    enhancedChars,
    baselineApproxTokens: Math.round(baselineChars / APPROX_CHARS_PER_TOKEN),
    enhancedApproxTokens: Math.round(enhancedChars / APPROX_CHARS_PER_TOKEN),
    charReductionPct: pct(baselineChars, enhancedChars),
  };
}

async function main() {
  const start = await rt.call({ action: 'start' });
  if (!start.ok) {
    console.error('failed to start browser runtime:', start.message);
    process.exit(2);
  }

  const rows = [];
  for (const task of TASKS) {
    try {
      rows.push(await runTask(task));
    } catch (err) {
      rows.push({ task: task.name, url: task.url, error: err instanceof Error ? err.message : String(err) });
    }
  }
  await rt.call({ action: 'stop' });

  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({ tasks: rows }, null, 2));

  console.log('\n=== Browser capability benchmark (snapshot → extract payload) ===\n');
  for (const r of rows) {
    if (r.error) {
      console.log(`✗ ${r.task}\n    error: ${r.error}\n`);
      continue;
    }
    console.log(
      `• ${r.task}\n` +
        `    baseline snapshot : ${r.baselineChars} chars (~${r.baselineApproxTokens} tok)\n` +
        `    targeted extract  : ${r.enhancedChars} chars (~${r.enhancedApproxTokens} tok)\n` +
        `    reduction         : ${r.charReductionPct}%\n`,
    );
  }
  console.log(`report: ${reportPath}`);

  const measured = rows.filter((r) => !r.error && r.baselineOk && r.enhancedOk);
  const allHalved = measured.length > 0 && measured.every((r) => r.charReductionPct >= 50);
  console.log(`\n=== ${allHalved ? 'PASS' : 'REVIEW'} (≥50% reduction on all measured tasks: ${allHalved}) ===`);
  process.exit(measured.length > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n=== BENCHMARK CRASH ===\n', err);
  process.exit(2);
});
