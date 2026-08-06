/**
 * Live integration check for the two paths only covered by unit tests so far:
 *   1. an interactive Site Recipe (type + submit + extract) on a real site
 *   2. the network primitives (requests → responseBody) reading a JSON XHR
 *
 * Launches a real headless Chrome (like scripts/smoke.mjs) and hits the network.
 * Run: node --import tsx scripts/browser-live-verify.mjs
 *
 * `loadRecipes()` uses Vite's import.meta.glob (only valid in the bundled app /
 * vitest), so here we fs-read the recipe file and feed the PURE parseRecipes().
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBrowserControlRuntime } from '../packages/browser-control-runtime/src/runtime.ts';
import { parseRecipes } from '../packages/lizi-mcps/src/browser/recipe-loader.ts';
import { runRecipe } from '../packages/lizi-mcps/src/browser/recipe-runner.ts';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const rt = createBrowserControlRuntime({
  config: { browser: { enabled: true, headless: true, ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } } },
  logSink: (level, scope, args) => {
    if (level === 'error') console.error(`[${scope}]`, ...args);
  },
});

const preview = (v, n = 240) => (typeof v === 'string' ? v : JSON.stringify(v)).slice(0, n);

async function verifyInteractiveRecipe() {
  console.log('\n=== 1. interactive recipe (scrapethissite hockey-search: type + submit + extract) ===');
  const file = path.join(repo, 'packages/lizi-mcps/src/browser/recipes/scrapethissite.com/recipe.json');
  const recipe = parseRecipes({ [file]: fs.readFileSync(file, 'utf8') }).get('hockey-search');
  const res = await runRecipe(recipe, { query: 'Boston' }, { call: (r) => rt.call(r) });
  console.log(`   ok=${res.ok}  steps=${JSON.stringify(res.steps)}`);
  if (!res.ok) {
    console.log(`   FAILED at step ${res.failedStep} (${res.failedAction}): ${res.message}`);
    return false;
  }
  const records = res.output?.result?.records ?? res.output?.records ?? res.output;
  console.log(`   output: ${preview(records)}`);
  const ok = Array.isArray(records) && records.length > 0;
  console.log(`   → ${ok ? 'PASS' : 'REVIEW'} (got ${Array.isArray(records) ? records.length : 0} records)`);
  return ok;
}

async function verifyNetwork() {
  console.log('\n=== 2. network (requests → responseBody) on quotes.toscrape.com/scroll (AJAX → /api/quotes) ===');
  await rt.call({ action: 'navigate', url: 'https://quotes.toscrape.com/scroll' });
  await rt.call({ action: 'act', request: { kind: 'wait', loadState: 'networkidle' } });

  const reqs = await rt.call({ action: 'requests', filter: '/api/quotes' });
  const list = reqs.data?.requests ?? reqs.data ?? [];
  const apiCount = Array.isArray(list) ? list.length : 0;
  console.log(`   requests(filter="/api/quotes"): ok=${reqs.ok}, matched=${apiCount}`);
  if (apiCount > 0) console.log(`     e.g. ${preview(Array.isArray(list) ? list[0] : list, 160)}`);

  // responseBody WAITS for the next matching response — so arm it FIRST, then
  // trigger the request (here: navigate to the endpoint). Reading "after the
  // fact" misses it (the response already arrived).
  const bodyPromise = rt.call({ action: 'responseBody', url: 'api/quotes', maxChars: 400 });
  await rt.call({ action: 'navigate', url: 'https://quotes.toscrape.com/api/quotes?page=1' });
  const body = await bodyPromise;
  const text = body.data?.response?.body ?? body.data?.body ?? body.data;
  console.log(`   responseBody: ok=${body.ok}`);
  console.log(`     body: ${preview(text, 220)}`);
  const reqOk = reqs.ok && apiCount > 0;
  const bodyOk = body.ok && /quotes|author|"text"/i.test(typeof text === 'string' ? text : JSON.stringify(text));
  console.log(`   → requests ${reqOk ? 'PASS' : 'REVIEW'} / responseBody ${bodyOk ? 'PASS' : 'REVIEW'}`);
  return reqOk && bodyOk;
}

/** Run a seed-site recipe from its bundled file and check the output JSON. */
async function verifyApiRecipe(label, site, recipeId, inputs, expectRe) {
  console.log(`\n=== ${label} (${site} :: ${recipeId}) ===`);
  const file = path.join(repo, `packages/lizi-mcps/src/browser/recipes/${site}/recipe.json`);
  const recipe = parseRecipes({ [file]: fs.readFileSync(file, 'utf8') }).get(recipeId);
  const res = await runRecipe(recipe, inputs, { call: (r) => rt.call(r) });
  if (!res.ok) {
    console.log(`   FAILED at step ${res.failedStep} (${res.failedAction}): ${res.message}`);
    return false;
  }
  // output is the extract body record(s); pull the JSON text we asked for.
  const recs = res.output?.result?.records ?? res.output?.records ?? res.output;
  const body = Array.isArray(recs) ? recs[0]?.body : recs?.body;
  const text = typeof body === 'string' ? body : JSON.stringify(res.output);
  console.log(`   output: ${preview(text, 200)}`);
  const ok = expectRe.test(text);
  console.log(`   → ${ok ? 'PASS' : 'REVIEW'} (matched ${expectRe})`);
  return ok;
}

// Public-API recipes: {site dir, recipe id, sample inputs, expected substring}.
// Best-effort — some public APIs rate-limit / require a UA / block headless; a
// REVIEW means "verify the recipe in-app", not necessarily a broken recipe.
const PUBLIC_API_BATCH = [
  { site: 'news.ycombinator.com', id: 'hn-search', inputs: { query: 'javascript' }, expect: /"hits"/ },
  { site: 'npmjs.com', id: 'npm-search', inputs: { query: 'react' }, expect: /"objects"|"package"/ },
  { site: 'pypi.org', id: 'pypi-package', inputs: { package: 'requests' }, expect: /"info"/ },
  { site: 'developer.mozilla.org', id: 'mdn-search', inputs: { query: 'fetch' }, expect: /"documents"|"metadata"/ },
  { site: 'crates.io', id: 'crates-search', inputs: { query: 'serde' }, expect: /"crates"/ },
  { site: 'wikipedia.org', id: 'wikipedia-search', inputs: { query: 'rust programming' }, expect: /"search"/ },
  { site: 'arxiv.org', id: 'arxiv-search', inputs: { query: 'transformer' }, expect: /<entry|arxiv/i },
  { site: 'stackoverflow.com', id: 'stackoverflow-search', inputs: { query: 'async await' }, expect: /"items"/ },
  { site: 'huggingface.co', id: 'hf-model-search', inputs: { query: 'bert' }, expect: /"modelId"|"id"/ },
  { site: 'coingecko.com', id: 'coingecko-search', inputs: { query: 'bitcoin' }, expect: /"coins"/ },
  { site: 'dev.to', id: 'devto-articles', inputs: { tag: 'javascript' }, expect: /"title"|"url"/ },
  { site: 'lobste.rs', id: 'lobsters-feed', inputs: { feed: 'hottest' }, expect: /"comments_url"|"short_id"|"title"/ },
  { site: 'pubmed.ncbi.nlm.nih.gov', id: 'pubmed-search', inputs: { query: 'cancer' }, expect: /"esearchresult"/ },
  // login-wave public recipes (no login) — authored by cross-validation, spot-checked headless here.
  { site: 'store.steampowered.com', id: 'steam-search', inputs: { query: 'portal' }, expect: /"name"|"appid"|"price"/ },
  { site: 'finance.yahoo.com', id: 'yahoo-finance-quote', inputs: { symbol: 'AAPL' }, expect: /"chart"|"result"|"meta"|"regularMarketPrice"|"price"/ },
  { site: 'v2ex.com', id: 'v2ex-hot', inputs: {}, expect: /"title"|"node"/ },
  { site: 'bbc.com', id: 'bbc-news-feed', inputs: { section: 'news' }, expect: /<item|<rss|<title/ },
  { site: 'producthunt.com', id: 'producthunt-feed', inputs: {}, expect: /<entry|<feed|<title/ },
  { site: 'bsky.app', id: 'bluesky-user-posts', inputs: { username: 'bsky.app' }, expect: /"feed"|"post"|"handle"/ },
  { site: '36kr.com', id: '36kr-news', inputs: {}, expect: /<item|<rss|<title/ },
  { site: 'finance.sina.com.cn', id: 'sinafinance-news', inputs: { limit: '10' }, expect: /"feed"|"list"|"rich_text"|"data"/ },
  // anti-bot / login-gated: expected to REVIEW headless, verify in-app. reddit now
  // uses navigate-home + in-page evaluate fetch (output.result is the mapped array).
  { site: 'reddit.com', id: 'reddit-listing', inputs: { subreddit: 'programming' }, expect: /"title"|"children"/, antibot: true },
];

async function main() {
  const start = await rt.call({ action: 'start' });
  if (!start.ok) {
    console.error('failed to start runtime:', start.message);
    process.exit(2);
  }
  const results = {
    interactive: await verifyInteractiveRecipe().catch((e) => (console.error('recipe crash', e), false)),
    network: await verifyNetwork().catch((e) => (console.error('network crash', e), false)),
  };
  let i = 3;
  const apiResults = {};
  for (const t of PUBLIC_API_BATCH) {
    apiResults[t.id] = await verifyApiRecipe(`${i++}. ${t.site}${t.antibot ? ' (anti-bot,可能 REVIEW)' : ''}`, t.site, t.id, t.inputs, t.expect).catch(
      (e) => (console.error(`${t.id} crash`, e), false),
    );
  }
  await rt.call({ action: 'stop' });

  const pass = Object.entries(apiResults).filter(([, ok]) => ok).map(([k]) => k);
  const review = Object.entries(apiResults).filter(([, ok]) => !ok).map(([k]) => k);
  console.log(`\n=== engine: interactive=${results.interactive} network=${results.network} ===`);
  console.log(`=== public-API recipes: ${pass.length}/${PUBLIC_API_BATCH.length} PASS ===`);
  console.log(`    PASS:   ${pass.join(', ')}`);
  console.log(`    REVIEW: ${review.join(', ') || '(none)'}  (rate-limit/UA/anti-bot → verify in-app)`);
  // Gate on engine + at least the always-public ones working; don't fail the run
  // on flaky external APIs.
  process.exit(results.interactive && results.network && apiResults['hn-search'] ? 0 : 1);
}

main().catch((err) => {
  console.error('\n=== LIVE-VERIFY CRASH ===\n', err);
  process.exit(2);
});
