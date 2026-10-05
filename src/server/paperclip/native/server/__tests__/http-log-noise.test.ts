import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHttpLogger } from "../middleware/logger.js";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";
import { shouldDemoteHttpSuccessLog } from "../middleware/http-log-policy.js";

// 发行层 1.1.6：请求日志降噪回归（不再序列化完整 headers；高频成功 GET 轮询为 debug）。
function harness(level: "info" | "debug") {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, callback) { lines.push(...chunk.toString().split("\n").filter(Boolean)); callback(); } });
  const app = express();
  app.use(express.json());
  app.use(createHttpLogger(pino({ level, redact: [...HTTP_LOG_REDACT_PATHS] }, stream)));
  for (const path of ["/api/issues/:id", "/api/companies", "/api/companies/:id/agents", "/api/auth/get-session", "/api/health"]) {
    app.get(path, (req, res) => { if (req.query.fail === "404") res.status(404).json({ error: "missing" }); else if (req.query.fail === "500") res.status(500).json({ error: "boom" }); else res.json({ ok: true }); });
  }
  app.post("/api/issues", (_req, res) => { res.status(201).json({ ok: true }); });
  return { app, logs: () => lines.map(line => JSON.parse(line)) };
}

describe("HTTP request log noise", () => {
  it("logs only id, method, url, status and response time, never full headers", async () => {
    const { app, logs } = harness("info");
    await request(app).post("/api/issues").set("Cookie", "sid=cookie-canary").set("User-Agent", "agent-canary").send({ title: "x" }).expect(201);
    const [entry] = logs();
    expect(entry.msg).toBe("POST /api/issues 201");
    expect(entry.level).toBe(30);
    expect(entry.req).toEqual({ id: expect.anything(), method: "POST", url: "/api/issues" });
    expect(entry.res).toEqual({ statusCode: 201 });
    expect(entry.responseTime).toEqual(expect.any(Number));
    expect(JSON.stringify(entry)).not.toMatch(/cookie-canary|agent-canary|remoteAddress|headers/);
  });

  it("demotes successful polling GETs to debug and keeps their failures visible", async () => {
    const info = harness("info");
    for (const path of ["/api/issues/1", "/api/companies", "/api/companies/c/agents", "/api/auth/get-session", "/api/health"]) {
      await request(info.app).get(path).expect(200);
    }
    expect(info.logs()).toEqual([]);
    await request(info.app).get("/api/issues/1?fail=404").expect(404);
    await request(info.app).get("/api/auth/get-session?fail=500").expect(500);
    expect(info.logs().map(entry => [entry.level, entry.res.statusCode])).toEqual([[40, 404], [50, 500]]);

    const debug = harness("debug");
    await request(debug.app).get("/api/companies").expect(200);
    expect(debug.logs().map(entry => [entry.level, entry.msg])).toEqual([[20, "GET /api/companies 200"]]);
  });

  it("limits demotion to successful safe reads of the polled API families", () => {
    expect(shouldDemoteHttpSuccessLog("GET", "/api/issues?status=todo", 200)).toBe(true);
    expect(shouldDemoteHttpSuccessLog("HEAD", "/api/health", 200)).toBe(true);
    expect(shouldDemoteHttpSuccessLog("POST", "/api/issues", 201)).toBe(false);
    expect(shouldDemoteHttpSuccessLog("GET", "/api/issues", 404)).toBe(false);
    expect(shouldDemoteHttpSuccessLog("GET", "/api/agents/1", 200)).toBe(false);
    expect(shouldDemoteHttpSuccessLog("GET", "/api/companies-archive", 200)).toBe(false);
  });
});
