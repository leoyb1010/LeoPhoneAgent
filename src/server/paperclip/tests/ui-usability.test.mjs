// 1.1.8：页面可用性审计补丁（catalogs/ui-usability.structural.json + native/ui-usability.patch.json）的接线与内容回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { orderedStructuralCatalogs } from '../scripts/structural-patches.mjs';
import { source, candidate, original, applyPatches, readJson } from './helpers/patched.mjs';

const uiCatalog = readJson('catalogs/ui-usability.structural.json');
const nativePatch = readJson('native/ui-usability.patch.json');
const order = readJson('catalogs/order.json');
const applyScript = fs.readFileSync(new URL('../scripts/apply-native-cli-auth.mjs', import.meta.url), 'utf8');
const catalogDir = new URL('../catalogs/', import.meta.url);

/** 按 order.json 顺序把截至本 catalog 的所有结构补丁应用到固定源码（main.tsx 等上下文由更早的 catalog 生成）。 */
function uiPatched(file) {
  let text = original(file);
  for (const name of orderedStructuralCatalogs()) {
    const patches = JSON.parse(fs.readFileSync(new URL(name, catalogDir), 'utf8'));
    text = applyPatches(text, patches, file, `${name}: ${file}`);
    if (name === 'ui-usability.structural.json') break;
  }
  return text;
}
const nativePatched = file => applyPatches(original(file), nativePatch, file);
const candidateRead = file => fs.readFileSync(path.join(candidate, file), 'utf8');

test('usability catalog and native patch are registered in order.json and the native apply script', () => {
  assert.equal(order.structural.at(-1), 'ui-usability.structural.json');
  assert.ok(order.after.some(r => r.catalog === 'ui-usability.structural.json' && r.after === 'zzzzz-round2-session.structural.json' && r.reason));
  assert.match(applyScript, /'ui-usability\.patch\.json','round3-hardening\.patch\.json'/);
  for (const patch of [...uiCatalog, ...nativePatch]) {
    assert.ok(patch.file && patch.from && patch.to && patch.from !== patch.to, 'patch shape');
    assert.equal(patch.expected, 1);
  }
  assert.ok(nativePatch.every(p => /^(server\/src\/|packages\/shared\/src\/)/.test(p.file)));
  assert.ok(fs.existsSync(new URL('../native/server/services/issue-terminal-cleanup.ts', import.meta.url)));
});

test('query retry policy: 401/403/404 are never retried, other failures keep the 3-attempt default', { skip: !source }, () => {
  const main = uiPatched('ui/src/main.tsx');
  assert.match(main, /import \{ ApiError, ApiSessionChangedError, /);
  assert.match(main, /function shouldRetryQuery\(failureCount: number, error: unknown\): boolean \{\n  if \(error instanceof ApiError && \(error\.status === 401 \|\| error\.status === 403 \|\| error\.status === 404\)\) return false;\n  return failureCount < 3;\n\}/);
  assert.match(main, /refetchOnWindowFocus: true, retry: shouldRetryQuery \} \},/);
  // 直接执行该策略：模拟 ApiError 与普通错误。
  const body = main.match(/function shouldRetryQuery[\s\S]*?\n\}/)[0].replace(/: (number|unknown|boolean)/g, '');
  class ApiError extends Error { constructor(status) { super('x'); this.status = status; } }
  const shouldRetryQuery = new Function('ApiError', `${body}; return shouldRetryQuery;`)(ApiError);
  for (const status of [401, 403, 404]) assert.equal(shouldRetryQuery(0, new ApiError(status)), false);
  assert.equal(shouldRetryQuery(0, new ApiError(500)), true);
  assert.equal(shouldRetryQuery(2, new Error('network')), true);
  assert.equal(shouldRetryQuery(3, new Error('network')), false);
});

test('terminal tasks hide the recovery banner and recovery card; idle task pages poll every 5 s instead of 1 s', { skip: !source }, () => {
  const detail = uiPatched('ui/src/pages/IssueDetail.tsx');
  assert.match(detail, /\{issue\.executionBlocker && issue\.status !== "done" && issue\.status !== "cancelled" && \(\n\s*<ExecutionBlockerNotice/);
  assert.match(detail, /recoveryAction=\{issue\.status === "done" \|\| issue\.status === "cancelled" \? null : issue\.activeRecoveryAction \?\? null\}/);
  assert.match(detail, /refetchInterval: \(query\) => \(\(query\.state\.data\?\.length \?\? 0\) > 0 \? 1000 : 5000\),/);
  assert.match(detail, /refetchInterval: liveRunCount > 0 \? false : 5000,/);
  assert.match(detail, /hasLiveRuns \? 1000 : issueStatus === "in_progress" \? 5000 : false,/);
  assert.doesNotMatch(detail, /refetchInterval: 1000,/);
  assert.equal(original('ui/src/pages/IssueDetail.tsx').split('refetchInterval: 1000,').length - 1, 1, 'upstream still has exactly the one 1 s poll we relax');
});

test('signed-in users without organization access get a sign-out action', { skip: !source }, () => {
  const gate = uiPatched('ui/src/components/CloudAccessGate.tsx');
  assert.match(gate, /import \{ useSignOut \} from "@\/hooks\/useSignOut";/);
  const page = gate.slice(gate.indexOf('function NoBoardAccessPage()'), gate.indexOf('export function CloudAccessGate('));
  assert.match(page, /const signOut = useSignOut\(\);/);
  assert.match(page, /onClick=\{\(\) => signOut\.mutate\(\)\} disabled=\{signOut\.isPending\}/);
  assert.match(page, /\{signOut\.isPending \? "正在退出…" : "退出登录"\}/);
});

test('routine detail renders the translated error instead of the raw server 404 body', { skip: !source }, () => {
  const detail = uiPatched('ui/src/pages/RoutineDetail.tsx');
  assert.match(detail, /import \{ userErrorMessage \} from "@\/i18n\/zh-CN";/);
  assert.match(detail, /message=\{userErrorMessage\(error\)\}/);
  assert.doesNotMatch(detail, /error instanceof Error \? error\.message : "We couldn't load this routine\."/);
});

test('an on-demand onboarding wizard can be closed with a cancel button or Escape', { skip: !source }, () => {
  const wizard = uiPatched('ui/src/components/OnboardingWizard.tsx');
  assert.match(wizard, /if \(e\.key === "Escape" && onboardingOpen && !loading\) \{\n\s*e\.preventDefault\(\);\n\s*handleClose\(\);\n\s*return;\n\s*\}/);
  const anchor = wizard.indexOf('data-testid="onboarding-wizard"');
  const block = wizard.slice(anchor, anchor + 1200);
  assert.match(block, /\{onboardingOpen && \(\n\s*<button\n\s*type="button"\n\s*onClick=\{handleClose\}\n\s*disabled=\{loading\}\n\s*aria-label="关闭引导"/);
  assert.match(block, /\{"取消"\}/);
  assert.ok(wizard.includes('const [loading, setLoading]'), 'loading state the guard relies on exists upstream');
});

test('archived (terminated/deleted) agents are flagged by the timeline service, labelled in the chart and excluded from the agent count', { skip: !source }, () => {
  const type = nativePatched('packages/shared/src/types/work-timeline.ts');
  assert.match(type, /avatarUrl\?: string;\n[\s\S]*?archived\?: boolean;\n\}/);
  const service = nativePatched('server/src/services/work-timeline.ts');
  assert.match(service, /appearance: agents\.appearance, status: agents\.status \}\)/);
  assert.match(service, /archived: !agent \|\| agent\.status === "terminated",/);
  const summary = uiPatched('ui/src/pages/Timeline.tsx');
  assert.match(summary, /if \(spanActor\?\.type === "agent" && !spanActor\.archived\) activeAgentIds\.add\(span\.actorId\);/);
  const chart = uiPatched('ui/src/components/timeline/WorkTimelineChart.tsx');
  assert.equal(chart.split('row.actor.archived ? `${row.actor.name}（已归档）` : row.actor.name').length - 1, 2);
});

test('company deletion removes projects before goals (projects.goal_id has no cascade)', { skip: !source }, () => {
  const companies = nativePatched('server/src/services/companies.ts');
  const projectsAt = companies.indexOf('await tx.delete(projects).where(eq(projects.companyId, id));');
  const goalsAt = companies.indexOf('await tx.delete(goals).where(eq(goals.companyId, id));');
  assert.ok(projectsAt > 0 && goalsAt > projectsAt, 'projects are deleted before goals');
  assert.equal(companies.split('await tx.delete(projects).where(eq(projects.companyId, id));').length - 1, 1);
  const upstream = original('server/src/services/companies.ts');
  assert.ok(upstream.indexOf('tx.delete(goals)') < upstream.indexOf('tx.delete(projects)'), 'upstream order is the bug being fixed');
  // 清单之外仍引用 company_id 的表（budget_policies 等）由同一事务内的 savepoint 清扫删除。
  assert.match(companies, /import \{ deleteRemainingCompanyRows \} from "\.\/company-deletion-sweep\.js";/);
  const sweepAt = companies.indexOf('const sweep = await deleteRemainingCompanyRows(tx, id);');
  const companyDeleteAt = companies.indexOf('.delete(companies)');
  assert.ok(companies.indexOf('await tx.delete(agents).where(eq(agents.companyId, id));') < sweepAt && sweepAt < companyDeleteAt);
  assert.match(companies, /if \(sweep\.unresolved\.length > 0\) \{\n\s*throw new Error\(/);
  const sweep = fs.readFileSync(new URL('../native/server/services/company-deletion-sweep.ts', import.meta.url), 'utf8');
  assert.match(sweep, /column_name = 'company_id' and c\.table_name <> 'companies'/);
  assert.match(sweep, /t\.table_type = 'BASE TABLE'/);
  assert.match(sweep, /savepoint leophone_company_sweep/);
  assert.match(sweep, /rollback to savepoint leophone_company_sweep/);
  assert.match(sweep, /sql`delete from \$\{sql\.identifier\(table\)\} where company_id = \$\{companyId\}`/);
  assert.match(sweep, /\.filter\(\(name\) => \/\^\[a-z_\]\[a-z0-9_\]\*\$\/\.test\(name\)\)/, 'table names are validated before being interpolated as identifiers');
});

test('cancelling a task cancels its deferred execution wakes once, after the run cancellation block', { skip: !source }, () => {
  const routes = nativePatched('server/src/routes/issues.ts');
  assert.match(routes, /import \{ cancelDeferredIssueExecutionWakes \} from "\.\.\/services\/issue-terminal-cleanup\.js";/);
  assert.equal(routes.split('await cancelDeferredIssueExecutionWakes(db, {').length - 1, 1);
  const call = routes.indexOf('if (issue.status === "cancelled" && existing.status !== "cancelled") {');
  const cancelBlock = routes.indexOf('details: { source: "issue_status_cancelled", issueId: existing.id },');
  const assignment = routes.indexOf('if (req.body.assigneeAgentId !== undefined) {', cancelBlock);
  assert.ok(cancelBlock < call && call < assignment);
  assert.match(routes, /action: "issue\.deferred_wakes_cancelled",/);
  const module = fs.readFileSync(new URL('../native/server/services/issue-terminal-cleanup.ts', import.meta.url), 'utf8');
  assert.match(module, /eq\(agentWakeupRequests\.status, "deferred_issue_execution"\)/);
  assert.match(module, /\.set\(\{ status: "cancelled", finishedAt: new Date\(\), error: input\.reason \?\? "issue_cancelled" \}\)/);
  assert.match(module, /->>'issueId' = \$\{input\.issueId\}/);
  assert.doesNotMatch(module, /\.delete\(/, 'audit rows are kept; only the status changes');
});

test('candidate tree carries every usability patch', { skip: !candidate }, () => {
  for (const patch of [...uiCatalog, ...nativePatch]) {
    const text = candidateRead(patch.file);
    const marker = patch.to.split('\n').find(line => line.trim() && !patch.from.includes(line));
    assert.ok(text.includes(marker ?? patch.to), `candidate missing patch output: ${patch.file}`);
  }
  assert.equal(candidateRead('server/src/services/issue-terminal-cleanup.ts'), fs.readFileSync(new URL('../native/server/services/issue-terminal-cleanup.ts', import.meta.url), 'utf8'));
  assert.equal(candidateRead('server/src/services/company-deletion-sweep.ts'), fs.readFileSync(new URL('../native/server/services/company-deletion-sweep.ts', import.meta.url), 'utf8'));
});
