import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { invokeApiCallTool } from "../../src/agent/tools.ts";
import type { Tool } from "../../src/registry/schema.ts";

function spinUp(handler: (c: any) => Response | Promise<Response>) {
  const app = new Hono();
  app.all("*", (c) => handler(c));
  return Bun.serve({ port: 0, fetch: app.fetch });
}

const SAMPLE_TOOL: Tool = {
  type: "api_call",
  name: "get_forecast",
  description: "d",
  parameters: { type: "object", properties: {}, required: [] },
  endpoint: { method: "POST", path: "/api/forecast" },
};

describe("invokeApiCallTool", () => {
  it("posts JSON body to <base_url><path> with bearer", async () => {
    let captured: { auth?: string; body?: any } = {};
    const server = spinUp(async (c) => {
      captured.auth = c.req.header("Authorization");
      captured.body = await c.req.json();
      return Response.json({ ok: true, echoed: captured.body });
    });
    try {
      const res = await invokeApiCallTool({
        tool: SAMPLE_TOOL,
        baseUrl: `http://localhost:${server.port}`,
        appToken: "tok",
        input: { location: "NYC", days: 3 },
        defaultTimeoutMs: 1000,
      });
      expect(captured.auth).toBe("Bearer tok");
      expect(captured.body).toEqual({ location: "NYC", days: 3 });
      expect(res).toEqual({ ok: true, echoed: { location: "NYC", days: 3 } });
    } finally {
      server.stop();
    }
  });

  it("returns 4xx body as error object (no retry)", async () => {
    let calls = 0;
    const server = spinUp(() => {
      calls++;
      return Response.json({ message: "bad" }, { status: 400 });
    });
    try {
      const res = await invokeApiCallTool({
        tool: SAMPLE_TOOL,
        baseUrl: `http://localhost:${server.port}`,
        appToken: "t",
        input: {},
        defaultTimeoutMs: 1000,
      });
      expect(calls).toBe(1);
      expect(res).toEqual({ error: { status: 400, body: { message: "bad" } } });
    } finally {
      server.stop();
    }
  });

  it("retries once on 5xx and succeeds on retry", async () => {
    let calls = 0;
    const server = spinUp(() => {
      calls++;
      if (calls === 1) return new Response("err", { status: 500 });
      return Response.json({ ok: true });
    });
    try {
      const res = await invokeApiCallTool({
        tool: SAMPLE_TOOL,
        baseUrl: `http://localhost:${server.port}`,
        appToken: "t",
        input: {},
        defaultTimeoutMs: 1000,
      });
      expect(calls).toBe(2);
      expect(res).toEqual({ ok: true });
    } finally {
      server.stop();
    }
  });

  it("returns error after second 5xx", async () => {
    let calls = 0;
    const server = spinUp(() => {
      calls++;
      return new Response(JSON.stringify({ x: 1 }), { status: 502 });
    });
    try {
      const res = await invokeApiCallTool({
        tool: SAMPLE_TOOL,
        baseUrl: `http://localhost:${server.port}`,
        appToken: "t",
        input: {},
        defaultTimeoutMs: 1000,
      });
      expect(calls).toBe(2);
      expect((res as any).error.status).toBe(502);
    } finally {
      server.stop();
    }
  });

  it("times out per tool.timeout_ms and retries once", async () => {
    let calls = 0;
    const server = spinUp(async () => {
      calls++;
      await Bun.sleep(200);
      return Response.json({});
    });
    try {
      const res = await invokeApiCallTool({
        tool: { ...SAMPLE_TOOL, timeout_ms: 50 },
        baseUrl: `http://localhost:${server.port}`,
        appToken: "t",
        input: {},
        defaultTimeoutMs: 100,
      });
      expect(calls).toBe(2);
      expect((res as any).error.kind).toBe("timeout");
    } finally {
      server.stop();
    }
  });

  it("uses GET when method=GET (no body)", async () => {
    let captured: { method?: string; url?: string } = {};
    const server = spinUp((c) => {
      captured.method = c.req.method;
      captured.url = c.req.url;
      return Response.json({ ok: true });
    });
    try {
      await invokeApiCallTool({
        tool: { ...SAMPLE_TOOL, endpoint: { method: "GET", path: "/api/ping" } },
        baseUrl: `http://localhost:${server.port}`,
        appToken: "t",
        input: { ignored: true },
        defaultTimeoutMs: 1000,
      });
      expect(captured.method).toBe("GET");
      expect(captured.url).toContain("/api/ping");
    } finally {
      server.stop();
    }
  });
});
