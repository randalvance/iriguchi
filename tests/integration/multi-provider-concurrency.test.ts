import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store } from "../../src/registry/store.ts";
import { runAgentStream } from "../../src/agent/runner.ts";
import { spinUpFakeAnthropic } from "../helpers/fake-anthropic.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let store: Store;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "iri-concurrency-"));
  store = createStore({ dbPath: ":memory:" });
});
afterEach(async () => {
  store.close();
  await rm(tmp, { recursive: true, force: true });
});

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let s = "";
  for await (const x of stream) s += x;
  return s;
}

describe("multi-provider concurrency", () => {
  it("routes concurrent requests to their own provider's baseUrl", async () => {
    // provider-a authenticates api_key style, provider-b auth_token style, so
    // this also proves the two styles reach the wire differently.
    const headersA: Headers[] = [];
    const headersB: Headers[] = [];
    const fakeA = spinUpFakeAnthropic(
      { turns: [{ kind: "text", text: "FROM_A" }] },
      { onRequest: (r) => headersA.push(r.headers) },
    );
    const fakeB = spinUpFakeAnthropic(
      { turns: [{ kind: "text", text: "FROM_B" }] },
      { onRequest: (r) => headersB.push(r.headers) },
    );
    try {
      const commonManifestFields = {
        manifest_version: "1" as const,
        app: { id: "concurrent-app", name: "c", description: "c" },
      };
      store.upsertApp({
        id: "app-a",
        base_url: "http://unused",
        app_token: "tok-a",
        manifest: {
          ...commonManifestFields,
          app: { ...commonManifestFields.app, id: "app-a" },
          agents: [
            {
              id: "bot-a",
              name: "A",
              description: "d",
              system_prompt: "you are A",
              provider: "provider-a",
              tools: [],
              skills: [],
            } as any,
          ],
        },
      });
      store.upsertApp({
        id: "app-b",
        base_url: "http://unused",
        app_token: "tok-b",
        manifest: {
          ...commonManifestFields,
          app: { ...commonManifestFields.app, id: "app-b" },
          agents: [
            {
              id: "bot-b",
              name: "B",
              description: "d",
              system_prompt: "you are B",
              provider: "provider-b",
              tools: [],
              skills: [],
            } as any,
          ],
        },
      });

      const config = {
        tmpDir: tmp,
        maxAgentTurns: 5,
        toolCallTimeoutMs: 1000,
        providers: {
          "provider-a": {
            name: "provider-a",
            apiKey: "ak-a",
            baseUrl: `http://localhost:${fakeA.port}`,
            defaultModel: "claude-sonnet-4-6",
            authStyle: "api_key" as const,
          },
          "provider-b": {
            name: "provider-b",
            apiKey: "ak-b",
            baseUrl: `http://localhost:${fakeB.port}`,
            defaultModel: "claude-sonnet-4-6",
            authStyle: "auth_token" as const,
          },
        },
        defaultProvider: "provider-a",
      };

      const [outA, outB] = await Promise.all([
        collect(
          runAgentStream({
            config,
            store,
            request: {
              requestId: "01A",
              agentId: "bot-a",
              model: null,
              messages: [{ role: "user", content: "hi from A" }],
              showToolCalls: false,
            },
          }),
        ),
        collect(
          runAgentStream({
            config,
            store,
            request: {
              requestId: "01B",
              agentId: "bot-b",
              model: null,
              messages: [{ role: "user", content: "hi from B" }],
              showToolCalls: false,
            },
          }),
        ),
      ]);

      expect(outA).toContain("FROM_A");
      expect(outA).not.toContain("FROM_B");
      expect(outB).toContain("FROM_B");
      expect(outB).not.toContain("FROM_A");

      // Neither provider is offered the other's credential, in any header.
      expect(headersA.length).toBeGreaterThan(0);
      expect(headersB.length).toBeGreaterThan(0);
      const allOf = (hs: Headers[]) => hs.map((h) => JSON.stringify([...h])).join("\n");
      expect(allOf(headersA)).not.toContain("ak-b");
      expect(allOf(headersB)).not.toContain("ak-a");

      // api_key style presents the key as x-api-key; auth_token style presents
      // it as a bearer token. If these ever converge, the auth style is inert.
      expect(headersA[0].get("x-api-key")).toBe("ak-a");
      expect(headersB[0].get("authorization")).toBe("Bearer ak-b");
    } finally {
      fakeA.stop();
      fakeB.stop();
    }
  });
});
