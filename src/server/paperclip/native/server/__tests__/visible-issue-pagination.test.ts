import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues, projects } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("authorization precedes issue pagination", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let sequence = 0;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("pc-visible-pages-");
    db = createDb(database.connectionString);
  }, 90000);
  afterAll(async () => { await database?.cleanup(); }, 30000);

  async function seed(hiddenCount = 3) {
    const companyId = randomUUID();
    const offset = ++sequence * 1000;
    const id = (visible: boolean, n: number) => `${visible ? "ffffffff-ffff-4fff-8fff" : "00000000-0000-4000-8000"}-${(offset + n).toString(16).padStart(12, "0")}`;
    const hidden = Array.from({ length: hiddenCount }, (_, n) => id(false, n + 1));
    const visible = [id(true, 1), id(true, 2), id(true, 3)];
    await db.insert(companies).values({ id: companyId, name: "Pagination fixture", issuePrefix: `T${offset}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Scoped reader", role: "engineer", status: "active", adapterType: "process",
      permissions: { authorizationPolicy: { trustPreset: "low_trust_review", trustBoundary: { mode: "low_trust_review", companyId, issueIds: visible } } } }).returning();
    await db.insert(issues).values([...hidden, ...visible].map((id) => ({ id, companyId, title: "Fixture task", status: "todo", priority: "medium" })));
    const actor = { type: "agent", source: "agent_key", companyId, agentId: agent!.id };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    const list = (extra: Record<string, string> = {}) => request(app).get(`/api/companies/${companyId}/issues`)
      .query({ limit: "2", sortField: "id", sortDir: "asc", ...extra });
    return { companyId, agent: agent!, actor, hidden, visible, id, list };
  }

  it("returns full visible pages despite an entirely hidden first raw page, for cursor and offset callers", async () => {
    const fixture = await seed();
    const first = await fixture.list().expect(200);
    expect(first.body.map((row: { id: string }) => row.id)).toEqual(fixture.visible.slice(0, 2));
    const last = await fixture.list({ afterId: fixture.visible[1]! }).expect(200);
    expect(last.body.map((row: { id: string }) => row.id)).toEqual(fixture.visible.slice(2));
    const offset = await fixture.list({ offset: "1" }).expect(200);
    expect(offset.body.map((row: { id: string }) => row.id)).toEqual(fixture.visible.slice(1));
    for (const hidden of fixture.hidden) expect(JSON.stringify([first.body, last.body, offset.body])).not.toContain(hidden);
    const hiddenAnchor = await fixture.list({ afterId: fixture.hidden[0]! }).expect(200);
    const missingAnchor = await fixture.list({ afterId: "00000000-0000-4000-8000-000000000000" }).expect(200);
    expect(hiddenAnchor.body).toEqual(missingAnchor.body);
    expect(hiddenAnchor.body.map((row: { id: string }) => row.id)).toEqual(fixture.visible.slice(0, 2));
    await fixture.list({ afterId: fixture.hidden[0]!, offset: "1" }).expect(422);
  });

  it("preserves an outside-boundary mention grant from an active human", async () => {
    const fixture = await seed();
    const userId = `fixture-user-${sequence}`;
    await db.insert(companyMemberships).values({ companyId: fixture.companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    await db.insert(issueComments).values({ companyId: fixture.companyId, issueId: fixture.hidden[0]!, authorUserId: userId,
      body: `Please inspect [reader](agent://${fixture.agent.id}?i=search)` });
    const result = await fixture.list({ view: "compact" }).expect(200);
    expect(result.body.map((row: { id: string }) => row.id)).toEqual([fixture.hidden[0], fixture.visible[0]]);
    await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.principalId, userId));
    const revoked = await fixture.list({ view: "compact" }).expect(200);
    expect(revoked.body.map((row: { id: string }) => row.id)).toEqual(fixture.visible.slice(0, 2));
  });

  it("preserves the server-owned exact task directed by a human", async () => {
    const fixture = await seed();
    const directed = fixture.hidden[1]!;
    await db.update(issues).set({ assigneeAgentId: fixture.agent.id }).where(eq(issues.id, directed));
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: fixture.companyId, agentId: fixture.agent.id,
      source: "assignment", status: "claimed", requestedByActorType: "user", requestedByActorId: "fixture-human",
      payload: { issueId: directed, _paperclipWakeContext: { source: "issue.update" } } }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: fixture.companyId, agentId: fixture.agent.id, status: "running",
      wakeupRequestId: wake!.id, contextSnapshot: { issueId: directed } }).returning();
    await db.update(agentWakeupRequests).set({ runId: run!.id }).where(eq(agentWakeupRequests.id, wake!.id));
    Object.assign(fixture.actor, { runId: run!.id });
    const result = await fixture.list({ view: "compact" }).expect(200);
    expect(result.body.map((row: { id: string }) => row.id)).toEqual([directed, fixture.visible[0]]);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run!.id));
    const cancelled = await fixture.list({ view: "compact" }).expect(200);
    expect(cancelled.body.map((row: { id: string }) => row.id)).toEqual(fixture.visible.slice(0, 2));
  });

  it("backfills past hundreds of unauthorized mention candidates and hides private search existence", async () => {
    const fixture = await seed(320);
    const userId = `fixture-user-${sequence}`;
    await db.insert(companyMemberships).values({ companyId: fixture.companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    await db.insert(issueComments).values(fixture.hidden.map(issueId => ({ companyId: fixture.companyId, issueId, authorUserId: userId,
      body: `privatefixture look at agent://${fixture.agent.id} without a Markdown link` })));
    const normal = await fixture.list().expect(200);
    expect(normal.body.map((row: { id: string }) => row.id)).toEqual(fixture.visible.slice(0, 2));
    const privateQuery = await fixture.list({ q: "privatefixture" }).expect(200);
    const missingQuery = await fixture.list({ q: "unfindablefixture" }).expect(200);
    expect(privateQuery.body).toEqual([]);
    expect(missingQuery.body).toEqual(privateQuery.body);
    for (const hidden of fixture.hidden) expect(JSON.stringify(normal.body)).not.toContain(hidden);
  }, 60000);

  it("retains tasks authorized by the existing target-policy boundary semantics", async () => {
    const fixture = await seed();
    const [project] = await db.insert(projects).values({ companyId: fixture.companyId, name: "Target scope" }).returning();
    await db.update(issues).set({ projectId: project!.id, executionPolicy: { authorizationPolicy: {
      trustBoundary: { mode: "low_trust_review", companyId: fixture.companyId, projectIds: [project!.id] },
    } } }).where(eq(issues.id, fixture.hidden[0]!));
    const result = await fixture.list().expect(200);
    expect(result.body.map((row: { id: string }) => row.id)).toEqual([fixture.hidden[0], fixture.visible[0]]);
  });

  it("does not reuse a compact cached page after the same actor's read boundary changes", async () => {
    const fixture = await seed();
    const first = await fixture.list({ view: "compact" }).expect(200);
    expect(first.body.map((row: { id: string }) => row.id)).toEqual(fixture.visible.slice(0, 2));
    await db.update(agents).set({ permissions: { authorizationPolicy: { trustPreset: "low_trust_review",
      trustBoundary: { mode: "low_trust_review", companyId: fixture.companyId, issueIds: fixture.hidden } } } }).where(eq(agents.id, fixture.agent.id));
    const changed = await fixture.list({ view: "compact" }).expect(200);
    expect(changed.body.map((row: { id: string }) => row.id)).toEqual(fixture.hidden.slice(0, 2));
    expect(changed.headers["x-paperclip-request-cache"]).toBe("miss");
    for (const id of fixture.visible) expect(JSON.stringify(changed.body)).not.toContain(id);
  });
});
