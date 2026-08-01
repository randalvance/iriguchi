import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeSkills } from "../../src/agent/skills.ts";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { listen } from "../helpers/listen.ts";

describe("materializeSkills", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "iri-skills-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates cwd at <root>/agents/<id> with no skills", async () => {
    const cwd = await materializeSkills({
      tmpDir: root,
      agentId: "weather-bot",
      skills: [],
    });
    expect(cwd).toBe(join(root, "agents", "weather-bot"));
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
  });

  it("writes inline skill to .claude/skills/<name>/SKILL.md", async () => {
    const cwd = await materializeSkills({
      tmpDir: root,
      agentId: "weather-bot",
      skills: [
        {
          name: "weather-jargon",
          content: "---\nname: weather-jargon\ndescription: x\n---\n\n# body",
        },
      ],
    });
    const path = join(cwd, ".claude", "skills", "weather-jargon", "SKILL.md");
    const body = await readFile(path, "utf8");
    expect(body).toContain("name: weather-jargon");
    expect(body).toContain("# body");
  });

  it("fetches url-based skill", async () => {
    const server = listen({
      port: 0,
      fetch: () =>
        new Response("---\nname: remote\ndescription: x\n---\n\nremote body"),
    });
    try {
      const cwd = await materializeSkills({
        tmpDir: root,
        agentId: "remote-bot",
        skills: [{ name: "remote", url: `http://localhost:${server.port}/skill.md` }],
      });
      const body = await readFile(
        join(cwd, ".claude", "skills", "remote", "SKILL.md"),
        "utf8",
      );
      expect(body).toContain("remote body");
    } finally {
      server.stop();
    }
  });

  it("removes stale skill directories on re-materialize", async () => {
    const cwd = await materializeSkills({
      tmpDir: root,
      agentId: "bot",
      skills: [{ name: "a", content: "---\nname: a\ndescription: x\n---\n\nA" }],
    });
    expect(existsSync(join(cwd, ".claude/skills/a/SKILL.md"))).toBe(true);

    await materializeSkills({
      tmpDir: root,
      agentId: "bot",
      skills: [{ name: "b", content: "---\nname: b\ndescription: x\n---\n\nB" }],
    });
    expect(existsSync(join(cwd, ".claude/skills/a/SKILL.md"))).toBe(false);
    expect(existsSync(join(cwd, ".claude/skills/b/SKILL.md"))).toBe(true);
  });

  it("throws on fetch failure", async () => {
    await expect(
      materializeSkills({
        tmpDir: root,
        agentId: "bot",
        skills: [{ name: "x", url: "http://localhost:1/skill.md" }],
      }),
    ).rejects.toThrow();
  });

  it("throws with HTTP status message on URL fetch returning 5xx", async () => {
    const server = listen({
      port: 0,
      fetch: () => new Response("server fail", { status: 503 }),
    });
    try {
      await expect(
        materializeSkills({
          tmpDir: root,
          agentId: "bot",
          skills: [{ name: "broken", url: `http://localhost:${server.port}/s.md` }],
        }),
      ).rejects.toThrow(/failed to fetch skill broken: HTTP 503/);
    } finally {
      server.stop();
    }
  });

  it("aborts URL fetch after skillFetchTimeoutMs", async () => {
    const server = listen({
      port: 0,
      fetch: async () => {
        await sleep(200);
        return new Response("late");
      },
    });
    try {
      await expect(
        materializeSkills({
          tmpDir: root,
          agentId: "bot",
          skills: [{ name: "slow", url: `http://localhost:${server.port}/s.md` }],
          skillFetchTimeoutMs: 50,
        }),
      ).rejects.toThrow();
    } finally {
      server.stop();
    }
  });
});
