import express, { type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";

describe("request body rejection preserves the API admission boundary", () => {
  it("returns 413 before admitting an oversized JSON mutation", async () => {
    const mutation = vi.fn((_req: Request, res: Response) => res.json({ accepted: true }));
    const app = express();
    app.use(express.json({ limit: 16 }));
    app.post("/api/fixture", mutation);
    app.use(errorHandler);
    const response = await request(app).post("/api/fixture").send({ body: "fixture-only-oversized-payload" });
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: "Request body too large" });
    expect(mutation).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain("fixture-only-oversized-payload");
  });

  it("does not mistake an unrelated service error's status for parser rejection", async () => {
    const app = express();
    app.post("/api/fixture", (_req, _res, next) => next(Object.assign(new Error("server failure"), { status: 413 })));
    app.use(errorHandler);
    const response = await request(app).post("/api/fixture").send({});
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal server error" });
  });

  it("rejects malformed JSON with 400 without exposing parser bytes to response or error context", async () => {
    const app = express();
    let errorContext: unknown;
    const mutation = vi.fn((_req: Request, res: Response) => res.json({ accepted: true }));
    app.use((_req, res, next) => {
      res.on("finish", () => { errorContext = res.locals.errorContext; });
      next();
    });
    app.use(express.json());
    app.post("/api/fixture", mutation);
    app.use(errorHandler);
    const response = await request(app).post("/api/fixture").type("json").send('{"apiKey":"fixture-only-secret');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Invalid JSON body" });
    expect(mutation).not.toHaveBeenCalled();
    expect(errorContext).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain("fixture-only-secret");
  });
});
