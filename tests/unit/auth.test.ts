import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { generateToken, constantTimeEqual, bearerAuth } from "../../src/auth.ts";

describe("generateToken", () => {
  it("returns base64url-encoded 32-byte token", () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("returns distinct values each call", () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe("constantTimeEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });
  it("returns false for differing strings of equal length", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });
  it("returns false for differing lengths", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

describe("bearerAuth middleware", () => {
  it("passes through with valid bearer", async () => {
    const app = new Hono();
    app.use("*", bearerAuth({ tokens: ["secret"] }));
    app.get("/", (c) => c.text("ok"));
    const res = await app.request("/", {
      headers: { Authorization: "Bearer secret" },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 with OpenAI-shape error on missing header", async () => {
    const app = new Hono();
    app.use("*", bearerAuth({ tokens: ["secret"] }));
    app.get("/", (c) => c.text("ok"));
    const res = await app.request("/");
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("returns 401 on wrong token", async () => {
    const app = new Hono();
    app.use("*", bearerAuth({ tokens: ["secret"] }));
    app.get("/", (c) => c.text("ok"));
    const res = await app.request("/", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts dynamic token resolver", async () => {
    const app = new Hono();
    app.use("*", bearerAuth({ resolve: (c) => Promise.resolve(["dyn-token"]) }));
    app.get("/", (c) => c.text("ok"));
    const res = await app.request("/", {
      headers: { Authorization: "Bearer dyn-token" },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 with empty tokens array (no allowlist matches)", async () => {
    const app = new Hono();
    app.use("*", bearerAuth({ tokens: [] }));
    app.get("/", (c) => c.text("ok"));
    const res = await app.request("/", {
      headers: { Authorization: "Bearer anything" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 on non-Bearer scheme (Basic)", async () => {
    const app = new Hono();
    app.use("*", bearerAuth({ tokens: ["secret"] }));
    app.get("/", (c) => c.text("ok"));
    const res = await app.request("/", {
      headers: { Authorization: "Basic c2VjcmV0" },
    });
    expect(res.status).toBe(401);
  });

  it("throws at construction if neither tokens nor resolve is supplied", () => {
    expect(() => bearerAuth({})).toThrow(/tokens.*resolve/i);
  });
});
