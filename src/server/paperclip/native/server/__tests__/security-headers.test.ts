import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { nativeSecurityHeaders } from "../services/security-headers.js";

// 发行层 1.1.6：安全响应头回归。
function app(publicUrl?: string, trustProxy = false) {
  const instance = express();
  instance.disable("x-powered-by");
  if (trustProxy) instance.set("trust proxy", "loopback");
  instance.use(nativeSecurityHeaders({ publicUrl }));
  instance.get("/api/health", (_req, res) => { res.json({ status: "ok" }); });
  instance.get("/private", (_req, res) => { res.set("Referrer-Policy", "no-referrer"); res.send("ok"); });
  instance.use((_req, res) => { res.status(404).json({ error: "not found" }); });
  return instance;
}

describe("native security headers", () => {
  it("adds nosniff, referrer and framing headers to success and error responses without exposing Express", async () => {
    for (const path of ["/api/health", "/missing"]) {
      const response = await request(app("https://paperclip.example.invalid")).get(path);
      expect(response.headers["x-powered-by"]).toBeUndefined();
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
      expect(response.headers["strict-transport-security"]).toBe("max-age=15552000");
      expect(response.headers["content-security-policy"]).toBeUndefined();
    }
  });

  it("sends HSTS only for HTTPS requests or an https public URL", async () => {
    expect((await request(app("http://127.0.0.1:3100")).get("/api/health")).headers["strict-transport-security"]).toBeUndefined();
    expect((await request(app()).get("/api/health")).headers["strict-transport-security"]).toBeUndefined();
    expect((await request(app("not a url")).get("/api/health")).headers["strict-transport-security"]).toBeUndefined();
    const proxied = await request(app(undefined, true)).get("/api/health").set("X-Forwarded-Proto", "https");
    expect(proxied.headers["strict-transport-security"]).toBe("max-age=15552000");
  });

  it("lets a route keep its stricter referrer policy", async () => {
    const response = await request(app("https://paperclip.example.invalid")).get("/private");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });
});
