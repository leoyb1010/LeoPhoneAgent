import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const source = process.env.PAPERCLIP_SOURCE;
const red = process.env.PAPERCLIP_TEST_ORIGINAL === 'true';
const uiPatches = JSON.parse(fs.readFileSync(new URL('../catalogs/zz-costs-realtime.structural.json', import.meta.url)));
const backendPatches = JSON.parse(fs.readFileSync(new URL('../native/costs-realtime.patch.json', import.meta.url)));
const original = file => execFileSync('git', ['show', `HEAD:${file}`], { cwd: source, encoding: 'utf8', maxBuffer: 20e6 });
function patched(file) {
  let text = original(file);
  if (red) return text;
  for (const patch of [...uiPatches, ...backendPatches].filter(p => p.file === file)) {
    assert.equal(text.split(patch.from).length - 1, patch.expected, `exact pinned patch context: ${file}`);
    text = text.split(patch.from).join(patch.to);
  }
  return text;
}
function nodes(text, predicate) {
  const ast = ts.createSourceFile('production.tsx', text, ts.ScriptTarget.Latest, true);
  const found = [];
  function visit(n) { if (predicate(n, ast)) found.push(n); ts.forEachChild(n, visit); }
  visit(ast); return { ast, found };
}
function productionFunction(text, name, deps = {}) {
  const { ast, found } = nodes(text, n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.equal(found.length, 1, `production function: ${name}`);
  const js = ts.transpileModule(found[0].getText(ast).replace(/^export\s+/, ''), { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText;
  return new Function(...Object.keys(deps), `${js};return ${name};`)(...Object.values(deps));
}
async function realCache() {
  const { QueryClient } = await import(pathToFileURL(path.join(source, 'ui/node_modules/@tanstack/react-query/build/modern/index.js')));
  const { queryKeys } = await import(pathToFileURL(path.join(source, 'ui/src/lib/queryKeys.ts')));
  return { QueryClient, queryKeys };
}
test('all five exact source targets parse and summary additions remain optional', { skip: !source }, () => {
  for (const file of new Set([...uiPatches, ...backendPatches].map(p => p.file))) {
    const ast = ts.createSourceFile(file, patched(file), ts.ScriptTarget.Latest, true);
    assert.deepEqual(ast.parseDiagnostics, [], file);
    if (file.endsWith('/types/cost.ts') && !red) {
      for (const type of ['CostSummary', 'CostByAgent', 'CostByAgentModel', 'CostByProject']) {
        const summary = ast.statements.find(n => ts.isInterfaceDeclaration(n) && n.name.text === type);
        for (const name of ['reportedEventCount', 'unpricedEventCount', 'unpricedSubscriptionEventCount']) assert.ok(summary.members.find(m => m.name.getText() === name)?.questionToken, `${type}.${name}`);
      }
    }
  }
});
test('actual heartbeat invalidator reaches all ranged cost/provider/biller keys and preserves other companies', { skip: !source }, async () => {
  const { QueryClient, queryKeys } = await realCache();
  const client = new QueryClient();
  const text = patched('ui/src/context/LiveUpdatesProvider.tsx');
  const invalidate = productionFunction(text, 'invalidateHeartbeatQueries', { queryKeys, readString: productionFunction(text, 'readString') });
  const current = [queryKeys.costs('company', '2026-10-01', '2026-10-31'), queryKeys.costs('company', '2026-09-01', '2026-09-30'), queryKeys.usageByProvider('company', 'from', 'to'), queryKeys.usageByBiller('company', 'from', 'to'), queryKeys.usageWindowSpend('company')];
  const foreign = queryKeys.costs('other-company', 'from', 'to');
  for (const key of [...current, foreign]) client.setQueryData(key, { fixture: true });
  invalidate(client, 'company', {});
  for (const key of current) assert.equal(client.getQueryState(key).isInvalidated, true, JSON.stringify(key));
  assert.equal(client.getQueryState(foreign).isInvalidated, false);
  client.clear();
  for (const key of [...current, foreign]) client.setQueryData(key, { fixture: true });
  const activity = productionFunction(text, 'invalidateActivityQueries', { queryKeys, readString: productionFunction(text, 'readString'), readRecord: productionFunction(text, 'readRecord') });
  activity(client, 'company', { entityType: 'cost_event', action: 'cost.reported', details: {} }, { userId: null, agentId: null });
  for (const key of current) assert.equal(client.getQueryState(key).isInvalidated, true, `cost event: ${JSON.stringify(key)}`);
  assert.equal(client.getQueryState(foreign).isInvalidated, false);
  client.clear();
});
test('overview fallback is visible-query only and receipt states never fabricate a zero price', { skip: !source }, () => {
  const text = patched('ui/src/pages/Costs.tsx');
  const declarations = nodes(text, n => ts.isVariableDeclaration(n) && n.name.getText().includes('spendData'));
  assert.equal(declarations.found.length, 1);
  const options = declarations.found[0].initializer.arguments[0].properties;
  const property = name => options.find(p => p.name?.getText() === name)?.initializer?.getText();
  assert.equal(property('refetchInterval'), '30_000');
  assert.equal(property('refetchIntervalInBackground'), undefined);
  const display = productionFunction(text, 'formatInferenceSpend', { formatCents: cents => `$${(cents / 100).toFixed(2)}` });
  const base = { companyId: 'company', spendCents: 0, budgetCents: 0, utilizationPercent: 0 };
  assert.equal(display(undefined), '—');
  assert.equal(display(base), '已记录 $0.00（报价状态未知）');
  assert.equal(display({ ...base, reportedEventCount: 1, unpricedEventCount: 0 }), '$0.00');
  assert.equal(display({ ...base, reportedEventCount: 0, unpricedEventCount: 2, unpricedSubscriptionEventCount: 0 }), '未定价');
  assert.equal(display({ ...base, reportedEventCount: 0, unpricedEventCount: 2, unpricedSubscriptionEventCount: 2 }), '订阅内含');
  assert.equal(display({ ...base, spendCents: 120, reportedEventCount: 2, unpricedEventCount: 3, unpricedSubscriptionEventCount: 1 }), '$1.20 + 未定价用量');
  assert.equal(display({ ...base, spendCents: 120, reportedEventCount: 2, unpricedEventCount: 3, unpricedSubscriptionEventCount: 3 }), '$1.20 · 另有订阅内含');
  assert.equal(text.includes('formatCents(row.costCents)'), false);
  assert.equal(text.includes('formatCents(modelRow.costCents)'), false);
  assert.equal(text.split('formatInferenceSpend({ ...row, spendCents: row.costCents })').length - 1, 2);
  assert.equal(text.split('formatInferenceSpend({ ...modelRow, spendCents: modelRow.costCents })').length - 1, 1);
});
test('actual agent/project/model aggregators retain receipt status counts for every detail amount', { skip: !source }, async () => {
  const text = patched('server/src/services/costs.ts');
  const ui = patched('ui/src/pages/Costs.tsx');
  const display = productionFunction(ui, 'formatInferenceSpend', { formatCents: cents => `$${(cents / 100).toFixed(2)}` });
  const sql = (strings, ...values) => ({ strings: [...strings], values });
  sql.join = values => values;
  for (const method of ['byAgent', 'byProject', 'byAgentModel']) for (const receipt of [
    { costCents: 0, reportedEventCount: 1, unpricedEventCount: 0, unpricedSubscriptionEventCount: 0, label: '$0.00' },
    { costCents: 0, reportedEventCount: 0, unpricedEventCount: 2, unpricedSubscriptionEventCount: 0, label: '未定价' },
    { costCents: 0, reportedEventCount: 0, unpricedEventCount: 2, unpricedSubscriptionEventCount: 2, label: '订阅内含' },
    { costCents: 1, reportedEventCount: 1, unpricedEventCount: 2, unpricedSubscriptionEventCount: 0, label: '$0.01 + 未定价用量' },
  ]) {
    const selected = [];
    const chain = () => {
      const value = { from: () => value, leftJoin: () => value, innerJoin: () => value, where: () => value, groupBy: () => value, orderBy: () => value, as: () => ({ runId: 'run_id', projectId: 'project_id' }), then: resolve => Promise.resolve([{ ...receipt, agentId: 'agent', agentAppearance: null }]).then(resolve) };
      return value;
    };
    const db = { select: fields => { selected.push(fields); return chain(); }, selectDistinctOn: () => chain() };
    const { ast, found } = nodes(text, n => ts.isPropertyAssignment(n) && n.name.getText() === method && ts.isArrowFunction(n.initializer));
    assert.equal(found.length, 1);
    const js = ts.transpileModule(`const method = ${found[0].initializer.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText;
    const deps = { db, costEvents: { companyId: 'company', costCents: 'cost_cents', costStatus: 'cost_status', billingType: 'billing_type' }, agents: {}, issues: {}, projects: {}, activityLog: {}, eq: () => null, gte: () => null, lte: () => null, and: () => null, desc: () => null, isNotNull: () => null, sql, sumAsNumber: value => value, METERED_BILLING_TYPE: 'metered_api', SUBSCRIPTION_BILLING_TYPES: ['subscription_included'], resolveAgentAppearance: () => null, agentAvatarUrl: () => '' };
    const aggregate = new Function(...Object.keys(deps), `${js};return method;`)(...Object.values(deps));
    const [row] = await aggregate('company');
    for (const name of ['reportedEventCount', 'unpricedEventCount', 'unpricedSubscriptionEventCount']) assert.equal(row[name], receipt[name], `${method}.${name}`);
    assert.equal(display({ ...row, spendCents: row.costCents }), receipt.label, method);
    assert.ok(selected[0].reportedEventCount.strings.join('').includes("'reported'"));
    assert.ok(selected[0].unpricedSubscriptionEventCount.strings.join('').includes("'subscription_included'"));
  }
});
test('real runtime-state writer publishes the existing live status only after ledger success', { skip: !source }, async () => {
  const text = patched('server/src/services/heartbeat.ts');
  async function scenario(failLedger) {
    let settle; const receipt = new Promise((resolve, reject) => { settle = failLedger ? () => reject(new Error('ledger failed')) : resolve; });
    const published = []; const updates = [];
    const sql = (strings, ...values) => ({ strings, values });
    const writer = productionFunction(text, 'updateRuntimeState', {
      db: { update: table => ({ set: changes => ({ where: async () => { updates.push({ table, changes }); } }) }) },
      ensureRuntimeState: async () => {}, normalizeUsageTotals: usage => usage,
      normalizeLedgerBillingType: type => type ?? 'unknown',
      resolveCacheAdjustedCostUsd: productionFunction(text, 'resolveCacheAdjustedCostUsd'),
      normalizeBilledCostCents: productionFunction(text, 'normalizeBilledCostCents'),
      resolveLedgerCostStatus: productionFunction(text, 'resolveLedgerCostStatus'),
      resolveLedgerBiller: () => 'fixture', resolveLedgerScopeForRun: async () => ({ issueId: 'issue', projectId: null, billingCode: null }),
      agentRuntimeState: { agentId: 'agent_id' }, eq: () => null, sql, budgetHooks: {},
      costService: () => ({ createEvent: async () => receipt }),
      publishLiveEvent: event => published.push(event), buildHeartbeatRunStatusLiveEventPayload: run => ({ runId: run.id, status: run.status }),
    });
    const pending = writer({ id: 'agent', companyId: 'company', adapterType: 'codex_local' }, { id: 'run', status: 'succeeded' }, { usage: { inputTokens: 1, outputTokens: 2 }, costUsd: null, billingType: 'subscription_included' }, { legacySessionId: null });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(published.length, 0, 'no precommit live pulse');
    settle();
    if (failLedger) { await assert.rejects(pending, /ledger failed/); assert.equal(published.length, 0, 'failed ledger never reports committed costs'); }
    else { await pending; assert.deepEqual(published, [{ companyId: 'company', type: 'heartbeat.run.status', payload: { runId: 'run', status: 'succeeded' } }]); }
    assert.equal(updates.length, 1, 'no repeated durable run event, status write or wake');
  }
  await scenario(false); await scenario(true);
});
test('real cost summary returns receipt-state counts without changing the ledger amount', { skip: !source }, async () => {
  const text = patched('server/src/services/costs.ts');
  const { ast, found } = nodes(text, n => ts.isPropertyAssignment(n) && n.name.getText() === 'summary' && ts.isArrowFunction(n.initializer));
  assert.equal(found.length, 1);
  const selected = [];
  const db = { select: fields => ({ from: table => ({ where: async () => { selected.push(fields); return table.costCents ? [{ total: 125, reportedEventCount: 2, unpricedEventCount: 5, unpricedSubscriptionEventCount: 3 }] : [{ budgetMonthlyCents: 1000 }]; } }) }) };
  const js = ts.transpileModule(`const summary = ${found[0].initializer.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText;
  const sql = (strings, ...values) => ({ strings: [...strings], values });
  const summary = new Function('db', 'companies', 'costEvents', 'eq', 'gte', 'lte', 'and', 'sql', 'sumAsNumber', 'notFound', `${js};return summary;`)(db, { id: 'id' }, { companyId: 'company_id', costCents: 'cost_cents', costStatus: 'cost_status', billingType: 'billing_type' }, () => null, () => null, () => null, () => null, sql, value => value, () => new Error('missing'));
  const result = await summary('company');
  assert.deepEqual(result, { companyId: 'company', spendCents: 125, reportedEventCount: 2, unpricedEventCount: 5, unpricedSubscriptionEventCount: 3, budgetCents: 1000, utilizationPercent: 12.5 });
  const aggregate = selected[1];
  assert.ok(aggregate.reportedEventCount.strings.join('').includes("'reported'"));
  assert.ok(aggregate.unpricedEventCount.strings.join('').includes("'unpriced'"));
  assert.ok(aggregate.unpricedSubscriptionEventCount.strings.join('').includes("'subscription_included'"));
  assert.deepEqual(aggregate.unpricedSubscriptionEventCount.values, ['cost_status', 'billing_type']);
});
